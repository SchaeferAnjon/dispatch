// OpenCode's session storm (kanban task-mpidn): with 200 OpenCode sessions the agent host knows and OpenCode no
// longer has (fixtures/opencode_storm.py), 0.9.2 ran `opencode db` once per missing id, again on every listing:
// about 45 at a time, the Mac's load at 367, and the side bar's pages took seconds to open. This counts the
// `opencode db` processes the instance runs and times a click on Waiting for you and on Projects (the Assistant's row
// was timed until it went, 2026-11-11) (mouse down to the page
// drawn, in the window's own clock), cold and after a window reload (what the window kept from the last time).
//
// Two starts make the storm (STORM_PHASE, see the fixture): seed lists the 300 sessions once; the caller stops the
// instance, keeps its profile folders and starts it again with STORM_PHASE=measure, which runs the measurements.
//   STORM_PHASE=seed    dispatch ide e2e run opencode-storm --fresh …      (then stash user-data …, see fixture)
//   STORM_PHASE=measure STORM_STASH=… dispatch ide e2e run opencode-storm --fresh …
// Results: storm.json in the run's folder.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const meta = {
  title: 'OpenCode session storm',
  description: 'Unknown OpenCode ids never start a process each; Waiting for you and Projects open at once.',
  needs: ['opencode'],
  instance: { fixture: 'opencode_storm' },
  timeout: 900,
};

const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Every process under the instance's app, as [pid, command] */
function instanceProcesses(rootPid) {
  const rows = execFileSync('/bin/ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\n').map(l => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(m => [Number(m[1]), Number(m[2]), m[3]]);
  const kids = new Map();
  for (const [pid, ppid] of rows) {
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  const mine = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    for (const k of kids.get(queue.shift()) || []) {
      if (!mine.has(k)) { mine.add(k); queue.push(k); }
    }
  }
  return rows.filter(([pid]) => mine.has(pid)).map(([pid, , cmd]) => [pid, cmd]);
}

const isOpencodeDb = cmd => /(^|\/)opencode\s+db\s/.test(cmd);

/** Samples the instance's `opencode db` processes every 200 ms until stopped: the most at once and how many in all. */
function watchProcesses(rootPid) {
  const seen = new Set();
  let most = 0;
  let samples = 0;
  let on = true;
  const loop = (async () => {
    while (on) {
      try {
        const db = instanceProcesses(rootPid).filter(([, cmd]) => isOpencodeDb(cmd));
        for (const [pid] of db) seen.add(pid);
        most = Math.max(most, db.length);
        samples++;
      } catch { /* ps busy: next sample */ }
      await sleep(200);
    }
  })();
  return { stop: async () => { on = false; await loop; return { most, total: seen.size, samples }; } };
}

function agentHostLog(rec) {
  const logs = join(rec.user_data_dir, 'logs');
  if (!existsSync(logs)) return '';
  const last = readdirSync(logs).sort().pop();
  const file = last && join(logs, last, 'agenthost.log');
  return file && existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/** Mouse down (the person's click) to the selector drawn, in the window's clock (ms). */
async function timeClick(ui, target, drawn, timeoutMs = 60000 * SCALE) {
  await ui.eval(`(() => {
    window.__stormT0 = undefined; window.__stormT1 = undefined;
    const done = () => { try { return (${drawn})(); } catch { return false; } };
    window.addEventListener('mousedown', () => {
      window.__stormT0 = performance.now();
      const tick = () => { if (done()) { window.__stormT1 = performance.now(); } else if (performance.now() - window.__stormT0 < ${timeoutMs}) { requestAnimationFrame(tick); } };
      requestAnimationFrame(tick);
    }, { capture: true, once: true });
    return true;
  })()`);
  await ui.click(target);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await ui.eval('[window.__stormT0, window.__stormT1]');
    if (r && typeof r[1] === 'number') return Math.round(r[1] - r[0]);
    await sleep(100);
  }
  return null;
}

const WAITING_DRAWN = `() => !!document.querySelector('.dispatch-waiting-page.dispatch-waiting-a .dispatch-waiting-intro, .dispatch-waiting-page.dispatch-waiting-a .dispatch-waiting-skeleton')`;
const PROJECTS_DRAWN = `() => { const b = document.querySelector('.dispatch-projects-body'); return !!b && b.isConnected && !!b.querySelector('.dispatch-projects-row, .dispatch-projects-tl-row, .dispatch-ap-empty') ; }`;
const WAITING = { css: '.dispatch-waiting-section' };
const PROJECTS = { css: '.dispatch-projects-section' };

async function closeTips(ui) {
  for (let i = 0; i < 5 && (await ui.exists({ css: 'button.dispatch-tour-close' })); i++) {
    await ui.click({ css: 'button.dispatch-tour-close' });
    await sleep(600);
  }
}

/** Somewhere that is neither page: the demo project's new-session page */
async function away(ui) {
  await ui.newSession(ui.demoFolder).catch(() => undefined);
  await sleep(1500);
}

export default async function (ui) {
  const phase = ui.rec.storm_phase || process.env.STORM_PHASE || 'seed';
  const out = { phase, app: ui.rec.app, build: ui.rec.build || {}, started: new Date().toISOString() };
  const save = () => writeFileSync(join(ui.out, 'storm.json'), JSON.stringify(out, null, 2));
  const watch = watchProcesses(ui.rec.pid);
  const t0 = Date.now();
  await ui.attach('agents', 120000 * SCALE).catch(() => ui.openAgents(ui.demoFolder));
  out.windowAt = Date.now() - t0;

  if (phase === 'seed') {
    // the agent host lists OpenCode's own sessions once it has its models; wait for that line, then for the registry
    const until = Date.now() + 240000 * SCALE;
    let line = '';
    while (Date.now() < until && !(line = (agentHostLog(ui.rec).match(/\[OpenCode\] (\d+) sessions of OpenCode's own to list/) || [])[0] || '')) await sleep(1000);
    out.discovered = line;
    if (!line) throw new Error('the agent host never listed OpenCode\'s sessions');
    await sleep(15000);
    out.processes = await watch.stop();
    save();
    await ui.screenshot('seed-list');
    return;
  }

  // the window as it comes up after the restart: sessions in the list
  const rows = await ui.eval(`document.querySelectorAll('.session-item').length`);
  out.sessionRowsAtAttach = rows;
  await closeTips(ui);
  await ui.waitFor(WAITING, { timeoutMs: 120000 * SCALE });
  await ui.waitFor(PROJECTS, { timeoutMs: 60000 * SCALE });

  out.clicks = [];
  const click = async (name, label) => {
    const ms = name === 'waiting' ? await timeClick(ui, WAITING, WAITING_DRAWN) : await timeClick(ui, PROJECTS, PROJECTS_DRAWN);
    out.clicks.push({ page: name, when: label, ms });
    save();
    return ms;
  };
  // cold: the first time in this window
  await click('waiting', 'first');
  await ui.screenshot('waiting-first');
  await click('projects', 'first');
  await ui.screenshot('projects-first');
  // again, three times each, from somewhere else
  for (let i = 0; i < 3; i++) {
    await away(ui);
    await click('waiting', `again ${i + 1}`);
    await away(ui);
    await click('projects', `again ${i + 1}`);
  }
  // a reload of the window: what it kept from the last time draws at once
  await ui.reloadWindow('agents');
  await closeTips(ui);
  await ui.waitFor(WAITING, { timeoutMs: 120000 * SCALE });
  await away(ui);
  await click('waiting', 'after reload');
  await ui.screenshot('waiting-after-reload');
  await click('projects', 'after reload');
  await ui.screenshot('projects-after-reload');
  // and a minute of the window just open on Projects, the way the person left it
  await sleep(60000);
  out.processes = await watch.stop();
  const log = agentHostLog(ui.rec);
  out.opencodeIndexLines = (log.match(/\[OpenCode\][^\n]*(index|database|sessions of OpenCode's)[^\n]*/g) || []).slice(-8);
  out.listSessions = (log.match(/listSessions computed[^\n]*/g) || []).slice(-3);
  out.finished = new Date().toISOString();
  save();
}
