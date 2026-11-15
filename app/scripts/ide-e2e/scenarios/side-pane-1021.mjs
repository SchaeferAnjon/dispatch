// 2026-10-21 round: a page in Docs opens in the integrated browser (preference「文档默认进浏览器」), the reader has
// no Enlarge of its own (the strip's maximize does it), Draw and ask on a page longer than the pane takes all of it
// and scrolls, and the file list button always shows the folder's files, not a second Changes.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
export const meta = { title: '右栏这一轮：网页进浏览器、整页 Draw and ask、文件列表按钮', description: 'Docs 里的网页默认在内置浏览器打开；阅读页没有第二个放大；浏览器里 Draw and ask 截整页能往下滑；文件列表按钮打开文件目录。' };
export default async function (ui) {
  const rec = ui.rec;
  const env = { ...process.env, BEADS_DIR: rec.beads_dir, DISPATCH_DIR: rec.dispatch_dir, DISPATCH_HOME: rec.dispatch_home, DISPATCH_BIN: rec.cli, DISPATCH_E2E_INSTANCE: rec.name };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE') || k.startsWith('CODEX_')) delete env[k];
  const cli = (...args) => execFileSync('python3', [rec.cli, ...args], { env, cwd: rec.folder, encoding: 'utf8', timeout: 90000 });
  const check = async (name, expr) => { const v = await ui.eval(expr); if (!v) throw Error(name); console.error('ok: ' + name); return v; };
  await ui.openAgents(rec.folder);
  await ui.newSession(rec.folder);
  await ui.openTab('Docs');
  const dir = path.join(rec.folder, 'design', 'round-1021'); fs.mkdirSync(dir, { recursive: true });
  // a page three screens long, each section with its own heading to find in the picture
  fs.writeFileSync(path.join(dir, 'long.html'), '<!doctype html><meta charset="utf-8"><title>Long page</title><style>body{font:16px system-ui;margin:0;background:#fff;color:#111}section{height:900px;border-bottom:4px solid #2f6f73;padding:24px}</style>' + Array.from({ length: 4 }, (_, i) => `<section id="s${i + 1}"><h2>Section ${i + 1}</h2><p>Draw and ask should reach this part too.</p></section>`).join(''));
  fs.writeFileSync(path.join(dir, 'reader.md'), '# Reader\n\nA short note.\n');

  // 1 the reader: Draw and ask and More Actions, no Enlarge of its own
  cli('ide', 'show', path.join(dir, 'reader.md'), '--json');
  await ui.waitFor({ css: '.dispatch-docs-reader-head' });
  const head = await ui.eval(`[...document.querySelectorAll('.dispatch-docs-reader-head button')].map(b => b.getAttribute('aria-label') || b.title || b.textContent.trim())`);
  console.error('reader head: ' + JSON.stringify(head));
  if (head.some(l => /Enlarge|Restore document/.test(l))) throw Error('the reader still has its own Enlarge: ' + JSON.stringify(head));
  await ui.screenshot('01-reader');

  // 2 an HTML page opens in the integrated browser, not the reader
  cli('ide', 'show', path.join(dir, 'long.html'), '--json');
  const page = await ui.browserPage('round-1021/long.html');
  await ui.sleep(800);
  await check('the page is a browser tab with ‹ Docs above it, not the Docs reader', `!document.querySelector('.dispatch-docs-frame') && document.body.innerText.includes('Integrated Browser') && document.body.innerText.includes('round-1021/long.html')`);
  const title = await page.eval('document.title');
  if (title !== 'Long page') throw Error('browser page title ' + title);
  await ui.screenshot('02-browser');
  await ui.mark({ css: '.tabs-container .tab.active' }, { what: '网页在内置浏览器里', where: '右栏，Docs 后面的标签', how: 'Docs 里点一篇网页，或 dispatch ide show' });

  // 3 Draw and ask on that page: the picture is the whole page and scrolls
  await ui.click({ aria: 'Draw and ask', exact: true });
  await ui.waitFor({ css: '.dispatch-draw-overlay .canvas' }, { timeoutMs: 60000 });
  await ui.sleep(500);
  const size = await check('the picture is taller than the pane', `(() => { const c = document.querySelector('.dispatch-draw-overlay .canvas'); return c && c.scrollHeight > c.clientHeight * 2 ? { scroll: c.scrollHeight, view: c.clientHeight } : null; })()`);
  console.error('draw canvas ' + JSON.stringify(size));
  const vp = await ui.eval(`(() => { const r = document.querySelector('.dispatch-draw-overlay .canvas').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const before = await ui.eval(`document.querySelector('.dispatch-draw-overlay .canvas').scrollTop`);
  await ui.mouse('mouseWheel', vp.x, vp.y, { deltaX: 0, deltaY: 1600 }); await ui.sleep(400);
  await check('the wheel scrolls down the page in Draw and ask', `document.querySelector('.dispatch-draw-overlay .canvas').scrollTop > ${before} + 400`);
  await ui.screenshot('03-draw-scrolled');
  await ui.mark({ css: '.dispatch-draw-overlay .canvas' }, { what: '整页都能画', where: '浏览器里的 Draw and ask', how: '滚轮往下，下面的内容也在图里' });
  await ui.press('Escape');
  await ui.waitFor({ css: '.dispatch-draw-overlay' }, { gone: true });

  // 4 the file list button on that tab: the folder's files, not Changes
  const container = `document.querySelector('.part.auxiliarybar .composite.viewlet:not([style*="display: none"])')?.id || [...document.querySelectorAll('.part.auxiliarybar .composite')].find(c => c.offsetParent)?.id`;
  const button = await ui.exists({ aria: 'Show or Hide File List' }) ? { aria: 'Show or Hide File List' } : { aria: 'Show in File List' };
  await ui.click(button);
  await ui.sleep(800);
  const shown = await ui.eval(container);
  console.error('detail shows: ' + shown);
  if (shown !== 'workbench.sessions.auxiliaryBar.filesContainer') throw Error('the file list button showed ' + shown);
  await ui.screenshot('04-file-list');
  await ui.mark({ css: '.part.auxiliarybar' }, { what: '文件目录', where: '右栏右边', how: '点标签条右上角的文件列表按钮' });

  // 5 the same on the Changes tab, where the button is the real toggle: hidden, then shown, it is the files again
  await ui.openTab('Changes');
  await ui.sleep(600);
  const toggle = { aria: 'Show or Hide File List' };
  if (await ui.eval(`!!document.querySelector('.part.auxiliarybar') && document.querySelector('.part.auxiliarybar').offsetWidth > 0`)) {
    await ui.click(toggle);
    await ui.sleep(500);
  }
  await ui.click(toggle);
  await ui.sleep(800);
  const again = await ui.eval(container);
  if (again !== 'workbench.sessions.auxiliaryBar.filesContainer') throw Error('on Changes the file list button showed ' + again);
  await ui.screenshot('05-file-list-on-changes');
}
