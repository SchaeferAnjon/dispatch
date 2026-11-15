// The Docs tab opens at once on a big project (user 2026-10-09: "Files opens at once, why does Docs take so long?
// where are the design drafts?"), lists the prototypes under design/ in Designs, and a page wider than the side
// pane fits the pane in the integrated browser, again when the pane is dragged.
// Everything happens in the instance's demo project, which gets 300 documents first; no engine messages.
// On a build without the first frame it still measures the list, so the same scenario gives both sides; the
// checks that build fails go into qa.json and fail the run at the end.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const meta = {
  title: 'Docs 秒开、设计稿进 Designs、宽页面适应右栏宽度',
  description: '300 份文档的项目里 Docs 页签第一帧的毫秒数；design/ 下的原型页在 Designs 里，点开能看；1400 px 宽的原型在 500 px 的右栏里（Docs 阅读页和内置浏览器）缩到看全，拖宽拖窄跟着变。',
  timeout: 900,
};

const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);
const WIDE = 1400;

function write(file, text, daysAgo = 0) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (daysAgo) {
    const t = Date.now() / 1000 - daysAgo * 86400;
    fs.utimesSync(file, t, t);
  }
  return file;
}

const deliveryPage = (title, kind) => `<!doctype html><html><head><meta charset="utf-8"><meta name="generator" content="dispatch deliver">
<meta name="dispatch-delivery" content="${kind}"><title>${title}</title></head><body style="font:15px system-ui;padding:24px"><h1>${title}</h1><p>A delivery page.</p></body></html>\n`;

/** A prototype laid out for a wide screen that clips itself, like design/frenzy/proto-a.html. */
const widePage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=${WIDE}"><title>Wide prototype</title><style>
*{box-sizing:border-box;margin:0}html,body{width:${WIDE}px;height:820px;overflow:hidden;background:#fafaf9;color:#0c0a09;font:14px/1.5 -apple-system,system-ui,sans-serif}
.cols{display:grid;grid-template-columns:260px 1fr 360px;height:100%}.cols>div{padding:24px;border-right:1px solid #e7e5e4}
#right-edge{position:absolute;top:24px;left:${WIDE - 220}px;width:200px;height:120px;background:#d9663a;color:#fff;padding:12px;border-radius:12px}
h1{font-size:28px}</style></head><body><div class="cols"><div><h1>Turbo</h1><p>Lanes on the left.</p></div><div><h1>One picture, time across</h1><p>${'The swimlane chart. '.repeat(40)}</p></div><div><p>Plan</p></div></div>
<div id="right-edge">Right edge: you see all of the page</div></body></html>\n`;

/** The instance's own dispatch CLI, on the instance's board and data (never the caller's). */
function cli(ui, args) {
  const rec = ui.rec, env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(VSCODE_|ELECTRON_|CLAUDE_CODE_|DISPATCH_|BEADS_|CODEX_THREAD|CODEX_SESSION)/.test(k) && k !== 'CLAUDECODE') env[k] = v;
  }
  Object.assign(env, { BEADS_DIR: rec.beads_dir, DISPATCH_DIR: rec.dispatch_dir, DISPATCH_HOME: rec.dispatch_home, DISPATCH_BIN: rec.cli,
    DISPATCH_E2E_INSTANCE: rec.name, PATH: `${ui.resources('tools')}:${process.env.PATH || '/usr/bin:/bin'}` });
  const r = spawnSync('python3', [rec.cli, ...args], { env, encoding: 'utf8', timeout: 120000, cwd: ui.demoFolder });
  if (r.status !== 0) throw new Error(`dispatch ${args.join(' ')}: ${(r.stderr || r.stdout || '').trim().slice(-400)}`);
  return r.stdout;
}

/** 300 documents: design drafts with prototypes, delivery pages, notes and research, as a project gathers them. */
function seed(root) {
  const made = { designs: [], protos: [], delivered: [] };
  for (let i = 0; i < 30; i++) {
    const d = path.join(root, 'design', `draft-${String(i).padStart(2, '0')}`);
    made.designs.push(write(path.join(d, 'README.md'), `# Design draft ${i}: list and reader\n\nDirection A and B.\n`, i % 7));
    write(path.join(d, 'index.html'), `<!doctype html><title>Draft ${i} prototype</title><body><h1>Draft ${i}</h1></body>`, i % 7);
    made.protos.push(write(path.join(d, `proto-${i % 2 ? 'b' : 'a'}.html`), `<!doctype html><title>Draft ${i} · variant</title><body><h1>Variant ${i}</h1></body>`, i % 7));
  }
  for (let i = 0; i < 10; i++) {
    made.delivered.push(write(path.join(root, 'design', `feature-${i}`, 'impl', 'index.html'), deliveryPage(`Feature ${i}: built`, 'impl'), i));
  }
  const wide = path.join(root, 'design', 'wide');
  write(path.join(wide, 'index.html'), deliveryPage('Turbo: one picture, time across', 'proposal'));
  write(path.join(wide, 'notes.md'), '# Turbo: one picture, time across\n\nThe proposal.\n');
  made.wide = write(path.join(wide, 'proto-a.html'), widePage);
  for (let i = 0; i < 205; i++) write(path.join(root, 'docs', 'notes', `note-${String(i).padStart(3, '0')}.md`), `# Note ${i}\n\nWhat was decided.\n`, 1 + (i % 20));
  for (let i = 0; i < 15; i++) write(path.join(root, '研究', `调研-${i}.md`), `# 调研 ${i}\n\n结论。\n`, 2);
  return made;
}

/** Drags the sash on the side pane's left edge until the pane is `width` wide (docs-tab.mjs). */
async function paneWidth(ui, width) {
  for (let round = 0; round < 3; round++) {
    const info = await ui.eval(`(() => { const g = [...document.querySelectorAll('.part.editor')].find(e => e.getBoundingClientRect().width > 0); const r = g.getBoundingClientRect(); const s = [...document.querySelectorAll('.monaco-sash.vertical')].map(e => e.getBoundingClientRect()).filter(b => b.height > 200 && Math.abs(b.x + b.width / 2 - r.x) < 12)[0]; return { w: r.width, right: r.right, sash: s ? { x: s.x + s.width / 2, y: s.y + s.height / 2 } : null }; })()`);
    if (!info.sash || Math.abs(info.w - width) < 6) return info.w;
    const to = info.right - width;
    await ui.mouse('mouseMoved', info.sash.x, info.sash.y);
    await ui.mouse('mousePressed', info.sash.x, info.sash.y, { button: 'left', clickCount: 1 });
    for (let i = 1; i <= 10; i++) await ui.mouse('mouseMoved', info.sash.x + ((to - info.sash.x) * i) / 10, info.sash.y, { button: 'left', buttons: 1 });
    await ui.mouse('mouseReleased', to, info.sash.y, { button: 'left', clickCount: 1 });
    await ui.sleep(700);
  }
  return ui.eval(`Math.round([...document.querySelectorAll('.part.editor')].find(e => e.getBoundingClientRect().width > 0).getBoundingClientRect().width)`);
}

const BROWSER_PAGE = `(() => { const e = document.getElementById('right-edge').getBoundingClientRect(); return { zoom: document.documentElement.style.zoom, view: innerWidth, right: e.right, left: e.left }; })()`;

/** The right edge box is on screen: element boxes are in the page's own pixels, the screen's are those times the zoom. */
const fits = (r) => !!r && r.view > 0 && r.right * (Number(r.zoom) || 1) <= r.view + 1;

/** Polls until the page reports a zoom that fits (the fit runs on the next frame after a resize). */
async function settled(read, view) {
  let last = null;
  for (let i = 0; i < 40; i++) {
    last = await read();
    if (last && (view === undefined || Math.abs(last.view - view) > 2 || i > 4) && fits(last)) return last;
    await new Promise(r => setTimeout(r, 250));
  }
  return last;
}

export default async function (ui) {
  const folder = ui.demoFolder;
  const made = seed(folder);
  const qa = { checks: [], failed: [], numbers: {} };
  const note = () => fs.writeFileSync(path.join(ui.out, 'qa.json'), JSON.stringify(qa, null, 2));
  const check = (name, ok, detail) => {
    (ok ? qa.checks : qa.failed).push(detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`);
    console.error(`${ok ? 'ok' : 'FAILED'}: ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`);
    note();
  };

  await ui.openAgents(folder);
  if (await ui.exists({ text: "Don't Show Again", exact: true })) await ui.click({ text: "Don't Show Again", exact: true });
  await ui.newSession();
  await ui.openTab('Tasks');
  await ui.sleep(1500);

  // 1. The first frame: from the click on Docs to the first row of the list
  await ui.eval(`(() => { const f = window.__docsFF = { t0: performance.now() }; const o = new MutationObserver(() => {
    const now = performance.now();
    if (!f.root && document.querySelector('.dispatch-docs')) f.root = now;
    if (!f.loading && document.querySelector('.dispatch-docs-empty')) f.loading = now;
    if (!f.rows && document.querySelector('.dispatch-docs-row')) f.rows = now;
    const r = document.querySelector('.dispatch-docs');
    if (!f.full && r && r.dataset.partial === 'false' && document.querySelector('.dispatch-docs-row')) { f.full = now; o.disconnect(); }
  }); o.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-partial'] }); })()`);
  await ui.openTab('Docs');
  // a session's own scope has nothing yet: the project's list
  const projectScope = { css: '.dispatch-docs-scope .dispatch-docs-pill:nth-child(2)' };
  await ui.waitFor(projectScope, { timeoutMs: 30000 });
  if (await ui.eval(`document.querySelector('.dispatch-docs-scope .dispatch-docs-pill:nth-child(2)').getAttribute('aria-selected') !== 'true'`)) await ui.click(projectScope);
  await ui.waitFor({ css: '.dispatch-docs-row' }, { timeoutMs: 120000 });
  const ff = await ui.eval(`(() => { const f = window.__docsFF, r = document.querySelector('.dispatch-docs'); return { clickToRows: Math.round(f.rows - f.t0), tabToRows: Math.round(f.rows - (f.root || f.t0)), editor: r && r.dataset.firstFrameMs ? Number(r.dataset.firstFrameMs) : null }; })()`);
  qa.numbers.firstFrame = ff;
  await ui.screenshot('01-first-frame');
  // the board's part (tasks, sessions) replaces the first frame a moment later
  for (let i = 0; i < 240 && !(await ui.eval(`!!window.__docsFF.full`)); i++) await ui.sleep(250);
  qa.numbers.fullList = await ui.eval(`window.__docsFF.full ? Math.round(window.__docsFF.full - window.__docsFF.t0) : null`);
  const firstMs = ff.editor ?? ff.tabToRows;
  check(`first frame under ${300 * SCALE} ms`, firstMs < 300 * SCALE, ff);
  const rows = await ui.eval(`document.querySelectorAll('.dispatch-docs-group-head .cnt').length ? [...document.querySelectorAll('.dispatch-docs-group-head')].map(h => [h.querySelector('.name').textContent, Number(h.querySelector('.cnt').textContent)]) : []`);
  qa.numbers.groups = rows;
  const total = rows.reduce((n, [, c]) => n + c, 0);
  check('about 300 documents listed', total >= 290, rows);
  await ui.screenshot('02-list');
  await ui.mark({ css: '.dispatch-docs-group-head' }, { what: 'Docs 列表：第一帧就按组分好', where: '右栏 Docs 页签', how: '点 Docs' });

  // 2. Designs: the prototypes under design/ are rows of their own
  await ui.click({ css: '.dispatch-docs-filter' });
  await ui.click({ text: 'Designs', exact: true, within: '.context-view' });
  await ui.waitFor({ css: '.dispatch-docs-group-head' }, { timeoutMs: 15000 });
  const designs = await ui.eval(`[...document.querySelectorAll('.dispatch-docs-group-head')].map(h => [h.querySelector('.name').textContent, Number(h.querySelector('.cnt').textContent)])`);
  qa.numbers.designs = designs;
  const designCount = (designs.find(([n]) => n === 'Designs') || [, 0])[1];
  check('Designs holds the drafts and their prototype pages', designCount >= 60, designs);
  // search the wide prototype by name (the group shows five rows; the search shows all of it)
  await ui.click({ css: '.dispatch-docs-search-box' });
  await ui.type('Wide prototype', { into: { css: '.dispatch-docs-search-input' } });
  const wideRow = { css: `.dispatch-docs-row[data-doc-path=${JSON.stringify(made.wide)}]` };
  const listed = await ui.waitFor(wideRow, { timeoutMs: 10000 }).then(() => true, () => false);
  check('design/wide/proto-a.html is a row in Designs', listed);
  await ui.screenshot('03-designs');
  if (listed) await ui.mark(wideRow, { what: '设计稿原型页（design/*/proto-a.html）', where: 'Docs › Designs', how: '筛选选 Designs，或搜它的名字' });

  // 3. A page from Docs opens in the integrated browser, in its own tab (fb6a2ee2: no reader for HTML any more)
  await paneWidth(ui, 500);
  // a build that does not list it: open it the way a delivery does, for the pictures of the rest
  if (listed) await ui.click(wideRow);
  else cli(ui, ['ide', 'show', made.wide]);
  await ui.waitFor({ css: '.tabs-container .tab.dispatch-tab-doc.active' }, { timeoutMs: 15000 });
  check('a page from Docs is not drawn in the Docs reader', !(await ui.exists({ css: '.dispatch-docs-frame' })));
  const page = await ui.browserPage('proto-a.html', { timeoutMs: 20000 });
  await ui.sleep(1500);
  const b500 = await settled(() => page.eval(BROWSER_PAGE));
  qa.numbers.browser500 = b500;
  check('integrated browser: the wide page fits a 500 px pane', fits(b500) && Number(b500.zoom) > 0 && Number(b500.zoom) < 1, b500);
  await ui.screenshot('06-browser-500');
  await page.screenshot('06-browser-500-page');
  await paneWidth(ui, 800);
  const b800 = await settled(() => page.eval(BROWSER_PAGE), b500?.view);
  qa.numbers.browser800 = b800;
  check('integrated browser: dragged wider, the page zooms in and still fits', !!b800 && b800.view > (b500?.view || 0) && fits(b800) && Number(b800.zoom) > Number(b500?.zoom || 0), b800);
  await ui.screenshot('07-browser-800');
  await paneWidth(ui, 420);
  const b420 = await settled(() => page.eval(BROWSER_PAGE), b800?.view);
  qa.numbers.browser420 = b420;
  check('integrated browser: dragged narrower, it zooms out again', fits(b420) && Number(b420.zoom) < Number(b800?.zoom || 1), b420);
  await ui.screenshot('08-browser-420');

  // 5. After a reload the list comes from the bridge's cache of the last full list, before the CLI answers
  await ui.reloadWindow();
  // the window comes back on the Assistant (task-cf46t): back to the demo project's session
  await ui.openAgents(folder);
  await ui.openTab('Docs');
  if (await ui.exists({ css: '.dispatch-docs-back' })) await ui.click({ css: '.dispatch-docs-back' });
  if (await ui.exists({ css: '.dispatch-docs-search-input' })) await ui.press('Escape');
  await ui.waitFor({ css: '.dispatch-docs-row' }, { timeoutMs: 60000 });
  const warm = await ui.eval(`(() => { const r = document.querySelector('.dispatch-docs'); return { editor: r.dataset.firstFrameMs ? Number(r.dataset.firstFrameMs) : null, partial: r.dataset.partial }; })()`);
  qa.numbers.afterReload = warm;
  check(`after a reload the cached list shows under ${300 * SCALE} ms`, warm.editor !== null && warm.editor < 300 * SCALE, warm);
  await ui.screenshot('09-after-reload');

  note();
  if (qa.failed.length) throw new Error(`failed: ${qa.failed.join('; ')}`);
}
