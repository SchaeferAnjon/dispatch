// Right panel tabs, direction B (task-fif4i): ten documents open, the strip keeps the one in front and the one before
// it, the Docs tab says 10, and the Docs list's Open group has all ten by project with their whole titles; a row opens
// its document, the search box filters, × closes one and Close closes a project's.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
export const meta = { title: '右栏标签：只留两篇，其余在 Docs 的 Open 里', description: '开 10 篇文档：标签条只有正在看的和上一篇，Docs 标签写 10；Docs 顶上 Open 一组按项目列全标题，点开、搜索、关掉。' };
export default async function (ui) {
  const rec = ui.rec;
  // it writes ten documents into the project and one into a project next to it: only into the seeded demo project
  // (a throwaway folder), never into a real one the instance was started on with --folder
  if (!rec.seed?.folder || rec.folder !== rec.seed.folder) throw new Error('tabs-open-list needs a seeded instance (no --folder): it writes documents into the project and next to it');
  const env = { ...process.env, BEADS_DIR: rec.beads_dir, DISPATCH_DIR: rec.dispatch_dir, DISPATCH_HOME: rec.dispatch_home, DISPATCH_BIN: rec.cli, DISPATCH_E2E_INSTANCE: rec.name };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE') || k.startsWith('CODEX_')) delete env[k];
  const cli = (...args) => execFileSync('python3', [rec.cli, ...args], { env, cwd: rec.folder, encoding: 'utf8', timeout: 90000 });
  const facts = {};
  const save = () => fs.writeFileSync(path.join(ui.out, 'result.json'), JSON.stringify(facts, null, 2));
  await ui.openAgents(rec.folder);
  await ui.newSession(rec.folder);
  await ui.openTab('Docs');

  // ten documents: six notes, a design page with its prototype and notes, one note of another project
  const notes = ['Alpha plan: what ships first', 'Beta review: what the tester found', 'Gamma notes: the build on the mini', 'Delta: why the tabs fold', 'Epsilon handoff: where the work stopped', 'Zeta: the release checklist'];
  const files = [];
  const dir = path.join(rec.folder, 'docs', 'open-list'); fs.mkdirSync(dir, { recursive: true });
  notes.forEach((t, i) => { const f = path.join(dir, `n${i + 1}.md`); fs.writeFileSync(f, `# ${t}\n\nA note to read.\n`); files.push(f); });
  const design = path.join(rec.folder, 'design', 'tabs-b'); fs.mkdirSync(design, { recursive: true });
  fs.writeFileSync(path.join(design, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Tabs B: two tabs and an Open list</title><h1>Proposal</h1>');
  fs.writeFileSync(path.join(design, 'proto-a.html'), '<!doctype html><meta charset="utf-8"><title>Tabs B prototype</title><p>Prototype</p>');
  fs.writeFileSync(path.join(design, 'notes.md'), '# Tabs B notes\n\nThe notes of the proposal.\n');
  files.push(path.join(design, 'index.html'), path.join(design, 'proto-a.html'), path.join(design, 'notes.md'));
  const other = path.join(path.dirname(rec.folder), 'shufang-reader', 'docs'); fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'palette.md'), '# 讲书换配色：书库不要灰配橙\n\nAnother project.\n');
  files.push(path.join(other, 'palette.md'));
  for (const f of files) { cli('ide', 'show', f, '--json'); await ui.sleep(700); }
  await ui.sleep(1500);

  const strip = () => ui.eval(`(() => {
    const tabs = [...document.querySelectorAll('.part.editor .tabs-container .tab')];
    return { all: tabs.length, shown: tabs.filter(t => getComputedStyle(t).display !== 'none').map(t => (t.getAttribute('aria-label') || '').split(',')[0].trim()),
      docs: document.querySelector('.part.editor .tabs-container .tab .dispatch-docs-count')?.textContent || '' };
  })()`);
  facts.strip = await strip();
  console.error('strip ' + JSON.stringify(facts.strip));
  if (facts.strip.docs !== '10') throw Error('the Docs tab does not say 10: ' + JSON.stringify(facts.strip));
  const fixed = ['Now', 'Changes', 'Files', 'Docs', 'Tasks', 'History'];
  const docTabs = facts.strip.shown.filter(n => !fixed.includes(n));
  if (docTabs.length !== 2) throw Error('the strip has not two documents: ' + JSON.stringify(facts.strip));
  if (!docTabs.includes('讲书换配色')) throw Error('the newest document is not on the strip by its short name: ' + JSON.stringify(docTabs));
  facts.kinds = await ui.eval(`[...document.querySelectorAll('.part.editor .tabs-container .tab.dispatch-tab-doc:not(.dispatch-tab-tucked)')].map(t => [...t.querySelector('.tab-label').classList].find(c => /^codicon-/.test(c)) || getComputedStyle(t.querySelector('.tab-label'), '::before').content)`);
  facts.divider = await ui.eval(`getComputedStyle(document.querySelector('.part.editor .tabs-container .tab.dispatch-tab-first-doc'), '::after').height`);
  if (facts.divider !== '20px') throw Error('no short line before the documents: ' + facts.divider);
  await ui.screenshot('01-strip-two-docs');
  await ui.mark({ css: '.part.editor .tabs-container .tab.active' }, { what: '标签条只留正在看的和上一篇', where: '右栏顶上，固定标签后面', how: '开多少篇都只有这两个' });
  await ui.mark({ css: '.part.editor .tabs-container .tab .dispatch-docs-count' }, { what: 'Docs 上写着开了 10 篇', where: 'Docs 标签', how: '点 Docs 看全部' });
  save();

  // the Open group: all ten, this project first, the other project's after it
  await ui.openTab('Docs');
  await ui.waitFor({ css: '.dispatch-docs-open' }, { timeoutMs: 20000 });
  const open = () => ui.eval(`(() => ({
    projects: [...document.querySelectorAll('.dispatch-docs-open-project')].map(p => p.querySelector('.pn')?.textContent + (p.querySelector('.this') ? ' (this)' : '') + ' ' + p.querySelector('.cnt')?.textContent),
    rows: [...document.querySelectorAll('.dispatch-docs-open-row')].map(r => (r.classList.contains('child') ? '  ' : '') + r.querySelector('.t')?.textContent),
    count: document.querySelector('.dispatch-docs-open .dispatch-docs-group-head .cnt')?.textContent }))()`);
  facts.open = await open();
  console.error('open ' + JSON.stringify(facts.open, null, 1));
  if (facts.open.count !== '10' || facts.open.rows.length !== 10) throw Error('the Open group does not list ten: ' + JSON.stringify(facts.open));
  if (!/\(this\)/.test(facts.open.projects[0] || '')) throw Error('this project is not first: ' + JSON.stringify(facts.open.projects));
  if (!facts.open.projects.some(p => p.startsWith('shufang-reader'))) throw Error('the other project has no group: ' + JSON.stringify(facts.open.projects));
  if (!facts.open.rows.includes('  Notes') || !facts.open.rows.some(r => r.startsWith('  Prototype'))) throw Error('the prototype and notes do not hang under their page: ' + JSON.stringify(facts.open.rows));
  if (!facts.open.rows.includes('Epsilon handoff: where the work stopped')) throw Error('a title is cut: ' + JSON.stringify(facts.open.rows));
  facts.docsInFront = await strip();
  facts.docsCountShown = await ui.eval(`(() => { const c = document.querySelector('.part.editor .tabs-container .tab.active .dispatch-docs-count'); return !!c && c.getBoundingClientRect().width > 0 && getComputedStyle(c).visibility !== 'hidden'; })()`);
  if (!facts.docsCountShown) throw Error('Docs in front does not show its count');
  await ui.screenshot('02-open-group');
  await ui.mark({ css: '.dispatch-docs-open' }, { what: 'Open：打开的全部文档，按项目分、写全标题', where: 'Docs 列表最上面', how: '点 Docs 标签' });
  await ui.mark({ css: '.dispatch-docs-open-row.child' }, { what: '原型和笔记挂在它的页面下面', where: 'Open 里设计稿那一行下面', how: '' });
  save();

  // a row opens its document: it comes onto the strip, the one in front before it stays
  await ui.click({ css: '.dispatch-docs-open-row', text: 'Beta review: what the tester found' });
  await ui.sleep(1200);
  facts.afterRow = await strip();
  const now = facts.afterRow.shown.filter(n => !fixed.includes(n));
  if (!now.includes('Beta review') || now.length !== 2) throw Error('the row did not bring its document onto the strip: ' + JSON.stringify(facts.afterRow));
  await ui.screenshot('03-row-opened');

  // a page of a file on the strip: the delivery symbol and the title up to its colon
  await ui.openTab('Docs');
  await ui.click({ css: '.dispatch-docs-open-row', text: 'Tabs B: two tabs and an Open list' });
  await ui.sleep(1500);
  facts.pageTab = await ui.eval(`(() => { const t = document.querySelector('.part.editor .tabs-container .tab.active'); const l = t?.querySelector('.tab-label'); return { name: (t?.querySelector('.label-name')?.textContent || '').trim(), icon: [...(l?.classList || [])].find(c => /^codicon-/.test(c)) || '' }; })()`);
  if (facts.pageTab.name !== 'Tabs B' || facts.pageTab.icon !== 'codicon-dispatch-delivery') throw Error('the page tab does not say what it is: ' + JSON.stringify(facts.pageTab));
  save();

  // search filters the open ones too
  await ui.openTab('Docs');
  await ui.click({ css: '.dispatch-docs-search-box' });
  await ui.type('讲书');
  await ui.sleep(600);
  facts.search = await open();
  if (facts.search.rows.length !== 1 || !/讲书换配色/.test(facts.search.rows[0]) || facts.search.count !== '1') throw Error('search did not keep only the other project\'s: ' + JSON.stringify(facts.search));
  facts.searchEmptyLine = await ui.eval(`[...document.querySelectorAll('.dispatch-docs-empty .et')].map(e => e.textContent)`);
  if (facts.searchEmptyLine.length) throw Error('an empty page under an Open group that matches: ' + JSON.stringify(facts.searchEmptyLine));
  await ui.screenshot('04-search');
  await ui.press('Escape');
  await ui.sleep(500);

  // × on a row closes it; Close on a project closes all of its
  await ui.hover({ css: '.dispatch-docs-open-row', text: 'Zeta: the release checklist' });
  // the × shows where the time was, under the pointer: clicked where a person sees it
  const box = await ui.eval(`(() => { const r = [...document.querySelectorAll('.dispatch-docs-open-row')].find(r => r.textContent.includes('Zeta')); const x = r?.querySelector('.dispatch-docs-open-x'); if (!x || !x.offsetWidth) return null; const b = x.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  if (!box) throw Error('no × on the row under the pointer');
  await ui.mouse('mouseMoved', box.x, box.y); await ui.sleep(200);
  await ui.mouse('mousePressed', box.x, box.y, { clickCount: 1 }); await ui.mouse('mouseReleased', box.x, box.y, { clickCount: 1 });
  await ui.sleep(1000);
  facts.afterClose = await open();
  if (facts.afterClose.rows.length !== 9 || facts.afterClose.rows.some(r => /Zeta/.test(r))) throw Error('× did not close it: ' + JSON.stringify(facts.afterClose));
  facts.stripAfterClose = await strip();
  if (facts.stripAfterClose.docs !== '9') throw Error('the Docs tab does not say 9: ' + JSON.stringify(facts.stripAfterClose));
  await ui.hover({ css: '.dispatch-docs-open-project', text: 'shufang-reader' });
  await ui.click({ css: '.dispatch-docs-open-project .dispatch-docs-close-all', text: 'Close' });
  await ui.sleep(1000);
  facts.afterProject = await open();
  if (facts.afterProject.projects.some(p => p.startsWith('shufang-reader'))) throw Error('Close did not close the project\'s docs: ' + JSON.stringify(facts.afterProject));
  await ui.screenshot('05-closed');
  save();

  // light and dark, with Docs in front and ten open again
  for (const f of files) { cli('ide', 'show', f, '--json'); await ui.sleep(400); }
  await ui.openTab('Docs');
  for (const mode of ['light', 'dark']) {
    await ui.setTheme(mode);
    await ui.sleep(800);
    await ui.screenshot(`06-docs-in-front-${mode}`);
  }
  save();
}
