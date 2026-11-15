// A new instance without the demo project (meta.instance.seed false); its two demo folders are made in the instance.
// Every transcript and board write stays in the instance or its demo folder.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// a loaded Mac (DISPATCH_E2E_TIME_SCALE) writes the 2535 fixture files and reads them back more slowly
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);
export const meta = { instance: { seed: false }, title: '首次登记项目、索引进度与同名文件夹', description: '真实点击 Add as project、等待后台索引自动刷新、分别登记两个 demo，再改显示名。' };

function cli(ui, args) {
  const r = ui.rec;
  const env = { ...process.env, HOME: path.join(r.root, 'home'), BEADS_DIR: r.beads_dir,
    DISPATCH_DIR: r.dispatch_dir, DISPATCH_HOME: r.dispatch_home,
    CODEX_HOME: path.join(r.root, 'codex-home'), DISPATCH_SESSION_ROOT: r.root,
    PATH: `${path.join(r.app, 'Contents/Resources/app/tools')}:${process.env.PATH}` };
  const result = spawnSync('python3', [r.cli, ...args, '--json'], { env, encoding: 'utf8', timeout: 90000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

export default async function (ui) {
  const r = ui.rec;
  assert.ok(/^(\/private)?\/tmp\/dide-e2e\//.test(r.root) && !r.seed, 'a test instance started without the demo project (meta.instance.seed false)');
  assert.equal(fs.existsSync(path.join(r.beads_dir, 'config.yaml')), false, 'The first Add must create the board');
  // two folders called demo, in the instance's own folder (its folders count as a person's: DISPATCH_SESSION_ROOT)
  const work = r.folder || path.join(r.root, 'work');
  const dirs = ['alpha', 'beta'].map(parent => path.join(work, parent, 'demo'));
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  const corpus = path.join(r.root, 'codex-home', 'sessions', 'fixture');
  fs.mkdirSync(corpus, { recursive: true });
  const timestamp = new Date().toISOString();
  const output = JSON.stringify({ type: 'response_item', timestamp, payload: { type: 'function_call_output', output: 'fixture '.repeat(65536) } });
  for (let i = 0; i < 2535; i++) {
    const sid = `${i.toString(16).padStart(8, '0')}-aaaa-4000-8000-000000000000`;
    const rows = [
      { type: 'session_meta', payload: { id: sid, cwd: dirs[i % 2], source: 'cli' } },
      { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Fixture session ${i}` }] } },
    ].map(x => JSON.stringify(x));
    fs.writeFileSync(path.join(corpus, `${sid}.jsonl`), [...rows, output, ''].join('\n'));
  }
  await ui.openAgents(work);
  await ui.click('Projects');
  // the bar shows while the first reading runs, once the page has its list (a minute on a busy Mac with a long
  // history); on a fast Mac the reading can be over before the page is open (the file says so)
  for (const until = Date.now() + 60000 * SCALE; ; await ui.sleep(250)) {
    if (await ui.exists({ css: '.dispatch-projects-index.visible' })) break;
    let p = {};
    try { p = JSON.parse(fs.readFileSync(path.join(r.dispatch_dir, 'index-progress.json'), 'utf8')); } catch { /* not started */ }
    if (p.state === 'done') break;
    if (Date.now() > until) throw new Error('neither the reading bar nor a finished reading after opening Projects: ' + JSON.stringify(p));
  }
  // The instance shares the real ~/.claude, so the index counts the fixture plus whatever Claude history the
  // Mac has (2692 on the MacBook on 2026-09-29), and a fast Mac finishes before the bar is read: the bar shows
  // at least the fixture while it runs, or the run is already done with at least that many.
  const progressFile = path.join(r.dispatch_dir, 'index-progress.json');
  const readProgress = () => { try { return JSON.parse(fs.readFileSync(progressFile, 'utf8')); } catch { return {}; } };
  for (const until = Date.now() + 30000 * SCALE; ; await ui.sleep(250)) {
    const max = Number(await ui.eval(`document.querySelector('.dispatch-projects-index [aria-valuemax]')?.getAttribute('aria-valuemax') || 0`));
    const p = readProgress();
    if (max >= 2535 || (p.state === 'done' && p.total >= 2535)) break;
    if (Date.now() > until) throw new Error(`index progress never reached the 2535 fixture sessions (bar ${max}, file ${JSON.stringify(p)})`);
  }
  if (await ui.exists({ css: '.dispatch-projects-index.visible' })) await ui.mark({ css: '.dispatch-projects-index.visible' }, { what: '首次读取会话的进度', where: 'Projects 页筛选栏下方', how: '第一次打开 Projects 时自动读取' });
  await ui.screenshot('01-reading-sessions');
  await ui.click({ text: 'All', exact: true, within: '.dispatch-projects-filters' });
  await ui.waitFor({ css: '.dispatch-projects-index.visible' }, { timeoutMs: 120000, gone: true });
  const progress = JSON.parse(fs.readFileSync(path.join(r.dispatch_dir, 'index-progress.json'), 'utf8'));
  assert.equal(progress.state, 'done');
  assert.ok(progress.total >= 2535, `indexed ${progress.total}, fewer than the fixture`);
  assert.equal(progress.done, progress.total);
  await ui.waitFor({ text: 'demo · alpha', exact: true, within: '.dispatch-projects-body' });
  await ui.waitFor({ text: 'demo · beta', exact: true, within: '.dispatch-projects-body' });
  await ui.screenshot('02-two-folders');
  for (let i = 0; i < 2; i++) {
    await ui.click({ text: 'Add as project', exact: true, within: '.dispatch-projects-body' });
    const until = Date.now() + 60000 * SCALE;
    while (Date.now() < until) {
      const count = await ui.eval("document.querySelectorAll('.dispatch-projects-row:not(.unregistered)').length");
      if (count === i + 1) break;
      await ui.sleep(250);
    }
    assert.ok(fs.existsSync(path.join(r.beads_dir, 'config.yaml')));
    if (i === 0) await ui.screenshot('03-first-project-added');
  }
  const registered = cli(ui, ['projects']);
  assert.equal(registered.length, 2);
  assert.deepEqual(new Set(registered.map(p => fs.realpathSync(p.dir))), new Set(dirs.map(d => fs.realpathSync(d))));
  assert.equal(new Set(registered.map(p => p.name)).size, 2);
  const beta = registered.find(p => fs.realpathSync(p.dir) === fs.realpathSync(dirs[1]));
  const alpha = registered.find(p => fs.realpathSync(p.dir) === fs.realpathSync(dirs[0]));
  await ui.screenshot('04-both-projects-added');
  await ui.mark({ css: '.dispatch-projects-body' }, { what: '两个同名文件夹分别保留', where: 'Projects 列表', how: '两个目录分别点 Add as project' });
  await ui.click({ text: beta.label, exact: true, within: '.dispatch-projects-body' });
  await ui.click('Rename Project');
  await ui.waitFor({ css: '.quick-input-widget input' });
  await ui.type('Demo workspace beta');
  await ui.press('Enter');
  // the page reads the projects again after the rename: with this Mac's whole history (thousands of sessions) that is seconds
  await ui.waitFor({ text: 'Demo workspace beta', exact: true }, { timeoutMs: 60000 });
  await ui.screenshot('05-project-renamed');
  const renamed = cli(ui, ['projects']);
  assert.equal(renamed.find(p => p.name === beta.name)?.label, 'Demo workspace beta');
  assert.equal(renamed.find(p => p.name === alpha.name)?.label, alpha.label);
  await ui.mark('Rename Project', { what: '项目显示名', where: '项目详情页右上角', how: '点 Rename Project 后输入名字，回车保存' });
  fs.writeFileSync(path.join(ui.out, 'fixture-result.json'), JSON.stringify({ progress, registered, renamed }, null, 2));
}
