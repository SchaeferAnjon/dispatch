// The Assistant's Timeline tab as design/frenzy direction A draws it (task "Timeline 页签按设计稿重做", design/timeline-design).
// The instance starts with a busy day (fixtures/timeline_many.py): 30 Claude Code sessions in four projects over the
// last 8 hours, 9 of them with helpers (one with six), and a Turbo run at the moment proto-a.html's scene "live" shows.
// Nothing is sent to a model. The person's path:
//   - the Timeline tab with the run: ten lanes with their names, what each does on the right, the legend, one Now line;
//   - the run stopped, "Your sessions": the sessions grouped by project, every lane named in a few words (never the
//     brief it was given), helpers folded into their session's lane, a click opens a card beside the lane that moves
//     nothing, "Open session" in it; the helpers chip shows them as rows and folds them back;
//   - light and dark, a wide and a narrow window; screenshots and the page's readings go to the run's folder.
// TIMELINE_BEFORE=1 takes the same screenshots without checking (the build before the redesign).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const meta = { instance: { fixture: 'timeline-many' }, timeout: 1200, title: 'Timeline: lanes as the design draws them', description: 'Sessions grouped by project with short names, helpers folded in, a card on click; the Turbo run with names, legend and one Now line; light, dark, wide, narrow.' };

const CHECK = !process.env.TIMELINE_BEFORE;
const run = promisify(execFile);
const WIDE = { width: 1600, height: 1000 };
const NARROW = { width: 1000, height: 820 };
function assert(v, m) { if (!v) throw new Error(m); }

async function cli(ui, ...args) {
  const bootstrap = "import os,sys,json; r=json.loads(sys.argv[1]); sys.path.insert(0,os.path.dirname(r['cli'])); import ide_e2e as E; env=E.instance_env(r); env.update(r.get('fixture_env') or {}); os.execve(sys.executable,[sys.executable,r['cli'],*sys.argv[2:]],env)";
  const r = await run('python3', ['-c', bootstrap, JSON.stringify(ui.rec), ...args], { env: process.env, maxBuffer: 16 * 1024 * 1024, timeout: 240000 }).catch(e => e);
  return r.stdout || '';
}

/** The sessions that are working: their transcripts get a line now (a session is working while it wrote in the last 90 s). */
function keepWorking(ui) {
  const stamp = new Date().toISOString();
  for (const f of ui.rec.timeline_working || []) {
    try { fs.appendFileSync(f, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Still on it.' }] }, timestamp: stamp }) + '\n'); } catch { /* gone: the lane just ends */ }
  }
}

async function closeTips(ui) {
  await ui.mouse('mouseMoved', 5, 5).catch(() => undefined);
  for (let i = 0; i < 5 && (await ui.exists({ css: 'button.dispatch-tour-close' })); i++) { await ui.click({ css: 'button.dispatch-tour-close' }); await ui.sleep(500); }
  for (let i = 0; i < 3 && (await ui.exists('Welcome to Dispatch')); i++) { await ui.press('Escape'); await ui.sleep(400); }
}

async function size(ui, s) {
  await ui.cdp.send('Emulation.setDeviceMetricsOverride', { width: s.width, height: s.height, deviceScaleFactor: 2, mobile: false });
  await ui.eval("window.dispatchEvent(new Event('resize'))");
  await ui.sleep(900);
}

const READ = `(() => {
  const t = document.querySelector('.dispatch-timeline');
  if (!t) return null;
  const vis = e => !!e && !!e.offsetParent && e.getBoundingClientRect().width > 0;
  const box = e => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const pop = t.querySelector('.dt-pop');
  const ps = pop && getComputedStyle(pop);
  return {
    title: t.querySelector('.dt-title')?.innerText.trim() || '',
    line: t.querySelector('.dt-line')?.innerText.trim() || '',
    timeline: box(t),
    lanes: [...t.querySelectorAll('.dt-lane')].map(l => ({ key: l.dataset.key || '', name: l.querySelector('.dt-name')?.innerText.trim() || '', nameShown: vis(l.querySelector('.dt-name')),
      side: l.querySelector('.dt-side')?.innerText.trim() || '', sideShown: vis(l.querySelector('.dt-side')), helper: l.classList.contains('helper'), helpers: l.querySelector('.dt-helpers')?.innerText.trim() || '',
      bars: l.querySelectorAll('.dt-bar').length, box: box(l) })),
    groups: [...t.querySelectorAll('.dt-group')].map(g => g.innerText.replace(/\\s+/g, ' ').trim()),
    folds: [...t.querySelectorAll('.dt-fold')].map(g => g.innerText.replace(/\\s+/g, ' ').trim()),
    legend: t.querySelector('.dt-legend')?.innerText.replace(/\\s+/g, ' ').trim() || '',
    nowLines: t.querySelectorAll('.dt-nowline').length,
    nowLabel: t.querySelector('.dt-now-label')?.innerText.trim() || '',
    names: t.querySelector('.dt-names') ? 'toggle' : '',
    detail: !!t.querySelector('.dt-detail'),
    pop: pop && vis(pop) ? { box: box(pop), title: pop.querySelector('.dt-pop-title')?.innerText.trim() || '', text: pop.innerText.replace(/\\s+/g, ' ').trim(),
      pad: [ps.paddingTop, ps.paddingRight, ps.paddingBottom, ps.paddingLeft].map(parseFloat), buttons: [...pop.querySelectorAll('button')].map(b => b.innerText.trim() || b.getAttribute('aria-label') || '') } : null,
    checks: t.querySelectorAll('.dt-mk.done').length,
    need: [...t.querySelectorAll('.dt-need')].map(n => n.innerText.replace(/\\s+/g, ' ').trim()),
    scrollW: document.documentElement.scrollWidth, innerW: innerWidth,
    // the numbers proto-a.html draws with, read the same way there (design/timeline-design): lane 32 high, bar 10 high
    // with radius 4, name 13 px, the status column 12 px, axis 11 px, the Now tag inverted with radius 4
    style: (() => {
      const cs = (sel, ...k) => { const e = t.querySelector(sel); if (!e) return null; const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return Object.assign({ h: Math.round(r.height), w: Math.round(r.width) }, Object.fromEntries(k.map(x => [x, s[x]]))); };
      return { lane: cs('.dt-lane:not(.dt-fold)', 'borderRadius'), bar: cs('.dt-bar.work', 'backgroundColor', 'borderRadius'), box: cs('.dt-box', 'borderStyle', 'borderRadius'),
        name: cs('.dt-lane .dt-name', 'fontSize', 'fontWeight', 'color'), side: cs('.dt-lane .dt-side', 'fontSize', 'color'), tick: cs('.dt-tick', 'fontSize'),
        now: cs('.dt-now-label', 'fontSize', 'backgroundColor', 'color', 'borderRadius'), dot: cs('.dt-track .dt-dot.working', 'backgroundColor'), lanes: cs('.dt-lanes', 'backgroundColor', 'borderTopWidth', 'borderRadius') };
    })(),
  };
})()`;

async function read(ui, name) {
  const v = await ui.eval(READ);
  fs.writeFileSync(path.join(ui.out, `${name}.json`), JSON.stringify(v, null, 2));
  return v;
}

async function settle(ui, test, what, ms = 60000) {
  const until = Date.now() + ms;
  let v;
  while (Date.now() < until) {
    keepWorking(ui);
    v = await ui.eval(READ);
    if (v && test(v)) return v;
    await ui.sleep(1500);
  }
  throw new Error(`the Timeline never showed ${what}: ${JSON.stringify(v).slice(0, 1500)}`);
}

/** The Timeline page: the Turbo run's row in the sessions list (since 2026-11-15 its only way in, task-ccmyi). */
async function openTimeline(ui) {
  for (let i = 0; i < 9; i++) {
    await closeTips(ui);
    // the run's row in the sessions list (the window reads the runs every 30 s: it can take that long to come)
    if (!(await ui.exists({ css: '.session-section.dispatch-turbo-row' }))) {
      await ui.sleep(8000);
      continue;
    }
    await ui.click({ css: '.session-section.dispatch-turbo-row .session-section-label' });
    await ui.sleep(1200);
    if (await ui.eval(`!!document.querySelector('.dispatch-timeline-page .dispatch-timeline')`)) return;
  }
  throw new Error('the Timeline page does not open');
}

/** Click the middle of an element's label (not a button in it), the way a person clicks a row. */
async function clickRow(ui, css) {
  const p = await ui.eval(`(() => { const e = document.querySelector(${JSON.stringify(css)}); if (!e) return null; const r = (e.querySelector('.dt-track') || e).getBoundingClientRect(); return { x: r.x + r.width * 0.5, y: r.y + r.height / 2 }; })()`);
  assert(p, `no ${css}`);
  await ui.mouse('mouseMoved', p.x, p.y);
  await ui.mouse('mousePressed', p.x, p.y, { button: 'left', clickCount: 1 });
  await ui.mouse('mouseReleased', p.x, p.y, { button: 'left', clickCount: 1 });
  await ui.sleep(700);
}

/** Where the lanes sit, from the first one: a card that pushed a lane down would change it (the page itself may scroll). */
const ys = v => v.lanes.map(l => l.box.y - v.lanes[0].box.y);
const RAW = /\.(ts|py|tex|txt|css|astro)\b|\/|You are a helper/;

export default async function (ui) {
  await ui.attach('agents', 90000).catch(() => ui.openAgents(ui.demoFolder));
  await ui.sleep(1500);
  await closeTips(ui);
  await size(ui, WIDE);
  await ui.setTheme('light');
  await openTimeline(ui);

  // ---- the Turbo run, at proto-a's moment
  let v = await settle(ui, x => x.lanes.length >= 3 && /下一版/.test(x.title), 'the Turbo run');
  await ui.sleep(1200);
  await ui.mouse('mouseMoved', 5, 5);
  v = await read(ui, '01-run-light-wide');
  await ui.screenshot('01-run-light-wide');
  if (CHECK) {
    assert(v.lanes.length === 10, `ten parts, ten lanes: ${v.lanes.length}`);
    assert(v.lanes.every(l => l.nameShown && l.name), 'every part lane shows its name');
    assert(v.lanes.every(l => l.sideShown), 'every part lane says what it does');
    assert(!v.names, 'no Names switch: names always show');
    assert(/working/i.test(v.legend) && /needs you/i.test(v.legend) && /planned/i.test(v.legend) && /combined/i.test(v.legend), `the legend: ${v.legend}`);
    assert(v.nowLines === 1 && /^Now \d\d:\d\d$/.test(v.nowLabel), `one Now line: ${v.nowLines} ${v.nowLabel}`);
    assert(v.checks === 2, `two combined checks: ${v.checks}`);
    assert(v.need.length === 1 && /GitHub login/.test(v.need[0]), 'the question waits at the top');
  }
  await ui.setTheme('dark');
  await ui.sleep(900);
  await read(ui, '02-run-dark-wide');
  await ui.screenshot('02-run-dark-wide');
  await size(ui, NARROW);
  v = await read(ui, '03-run-dark-narrow');
  await ui.screenshot('03-run-dark-narrow');
  if (CHECK) assert(v.scrollW <= v.innerW + 1, `no sideways scroll at ${NARROW.width}: ${v.scrollW}`);

  // a part's card on click: beside its lane, nothing moves
  if (CHECK) {
    await size(ui, WIDE);
    await ui.setTheme('light');
    await ui.sleep(1500);
    const before = await ui.eval(READ);
    await clickRow(ui, '.dt-lane[data-key="p4"]');
    v = await read(ui, '04-run-card');
    await ui.screenshot('04-run-card');
    assert(v.pop, 'a click on a part opens its card');
    fs.writeFileSync(path.join(ui.out, '04-before.json'), JSON.stringify(before, null, 2));
    assert(v.pop.title === '内置终端', `the card's title is the part's name: ${v.pop.title}`);
    assert(JSON.stringify(ys(v)) === JSON.stringify(ys(before)), 'opening the card moves no lane');
    await ui.press('Escape');
    await ui.sleep(500);
    assert(!(await ui.eval(READ)).pop, 'Escape closes the card');
  }

  // ---- the run stopped: the person's own sessions
  await cli(ui, 'turbo', 'cancel', ui.rec.run);
  try { process.kill(ui.rec.runner_pid, 'SIGTERM'); } catch { /* already gone */ }
  await size(ui, WIDE);
  await ui.setTheme('light');
  await ui.sleep(1500);
  await settle(ui, x => /Stopped/.test(x.line) || /Stopped/.test(x.title) || x.lanes.length === 0 || true, 'the stopped run', 5000);
  for (let i = 0; i < 20 && !(await ui.exists({ text: 'Your sessions', within: '.dispatch-timeline' })); i++) { keepWorking(ui); await ui.sleep(1500); }
  await ui.click({ text: 'Your sessions', within: '.dispatch-timeline' });
  v = await settle(ui, x => x.lanes.length >= 8, 'the sessions');
  await ui.sleep(1500);
  await ui.mouse('mouseMoved', 5, 5);
  keepWorking(ui);
  v = await read(ui, '05-sessions-light-wide');
  await ui.screenshot('05-sessions-light-wide');
  if (CHECK) {
    assert(v.lanes.every(l => l.nameShown && l.name), 'every session lane shows its name');
    const raw = v.lanes.filter(l => RAW.test(l.name) || l.name.length > 48);
    assert(!raw.length, `names are a few words, not the brief: ${raw.map(l => l.name).join(' | ')}`);
    assert(!v.lanes.some(l => l.helper), 'helpers are folded into their session by default');
    assert(v.lanes.some(l => l.helpers === '6'), `the session with six helpers says 6: ${v.lanes.map(l => l.helpers).join(',')}`);
    assert(v.groups.length === 4, `four projects: ${v.groups.join(' | ')}`);
    assert(v.nowLines === 1 && /^Now \d\d:\d\d$/.test(v.nowLabel), 'one Now line');
    assert(/working/i.test(v.legend) && /helper/i.test(v.legend), `the legend: ${v.legend}`);
    assert(!v.names, 'no Names switch');
  }
  await ui.setTheme('dark');
  await ui.sleep(900);
  await read(ui, '06-sessions-dark-wide');
  await ui.screenshot('06-sessions-dark-wide');
  await size(ui, NARROW);
  v = await read(ui, '07-sessions-dark-narrow');
  await ui.screenshot('07-sessions-dark-narrow');
  if (CHECK) assert(v.scrollW <= v.innerW + 1, `no sideways scroll at ${NARROW.width}: ${v.scrollW}`);
  await ui.setTheme('light');
  await ui.sleep(700);
  await read(ui, '08-sessions-light-narrow');
  await ui.screenshot('08-sessions-light-narrow');

  // ---- a click on a session: its card, beside the lane
  await size(ui, WIDE);
  await ui.sleep(1500);
  const before = await ui.eval(READ);
  const six = before.lanes.find(l => l.helpers === '6') || before.lanes[0];
  await clickRow(ui, `.dt-lane[data-key="${six.key}"]`);
  v = await read(ui, '09-session-card');
  await ui.screenshot('09-session-card');
  if (CHECK) {
    assert(v.pop, 'a click on a session opens its card');
    assert(!v.detail, 'no words pushed in between the lanes');
    assert(v.pop.title && !RAW.test(v.pop.title) && v.pop.title.length <= 48, `the card's title is a few words: ${v.pop.title}`);
    assert(v.pop.pad.every(p => p >= 12), `the card's words keep off its edges: ${v.pop.pad}`);
    assert(v.pop.buttons.some(b => /Open session/.test(b)), `Open session in the card: ${v.pop.buttons}`);
    assert(/6 helpers/.test(v.pop.text), `the card lists the helpers: ${v.pop.text}`);
    assert(JSON.stringify(ys(v)) === JSON.stringify(ys(before)), 'opening the card moves no lane');
    const t = v.timeline, p = v.pop.box;
    assert(p.x >= t.x - 1 && p.x + p.w <= t.x + t.w + 1, 'the card stays inside the Timeline');
  }
  // clicking the same lane again closes it
  await clickRow(ui, `.dt-lane[data-key="${six.key}"]`);
  if (CHECK) assert(!(await ui.eval(READ)).pop, 'a second click closes the card');

  // ---- the helpers chip: the helpers as rows under the session, and folded back
  if (CHECK) {
    await ui.click({ css: `.dt-lane[data-key="${six.key}"] .dt-helpers` });
    await ui.sleep(700);
    v = await read(ui, '10-helpers-open');
    await ui.mouse('mouseMoved', 5, 5);
    await ui.screenshot('10-helpers-open');
    const hs = v.lanes.filter(l => l.helper);
    assert(hs.length === 6, `six helper rows: ${hs.length}`);
    assert(hs.every(h => h.nameShown && !RAW.test(h.name)), `helpers named in a few words: ${hs.map(h => h.name).join(' | ')}`);
    assert(!v.pop, 'the chip opens the helpers, not the card');
    await ui.click({ css: `.dt-lane[data-key="${six.key}"] .dt-helpers` });
    await ui.sleep(700);
    assert(!(await ui.eval(READ)).lanes.some(l => l.helper), 'the chip folds them back');
  }
  await ui.cdp.send('Emulation.clearDeviceMetricsOverride');
}
