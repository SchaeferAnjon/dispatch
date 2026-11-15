// Idle cost of the Agents window (kanban task: Dispatch eats CPU while nobody touches it).
// The layout the person has open overnight: the Agents window on the new-session page (the swimming blocks), the
// left column with their projects and conversations, the right column on Now, the bottom bar. Nothing is clicked
// during the measurement. Measured, in this order:
//   1. warm-up (the first asks of every poller are over);
//   2. MEASURE_S seconds of CPU time of every process of the instance (ps, by type), the page's own main-thread
//      numbers (CDP Performance.getMetrics: task / script / layout / style time, layout and style counts), the
//      requestAnimationFrame calls, and how many `dispatch …` runs the extension host logged;
//   3. PROFILE_S seconds of the V8 sampling profiler: self time per function and per file;
//   4. the animations the page is running (document.getAnimations(): which, how many, on what).
// Result: perf-idle.json in the run's folder (and a short table on stdout).
//   PERF_LABEL=before|after  names the file (perf-idle-<label>.json)
// Two phases: focused (as the runner keeps the window), then unfocused and untouched (focus emulation off).
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const meta = {
  title: 'Idle CPU of the Agents window',
  description: 'CPU time per process, main-thread breakdown, profiler top list, running animations and dispatch runs per minute while nothing is touched.',
  instance: { motion: true, fixture: 'sidebar-groups' },
  timeout: 900,
};

const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);
const MEASURE_S = Number(process.env.PERF_MEASURE_S || 60);
const PROFILE_S = Number(process.env.PERF_PROFILE_S || 10);
const LABEL = process.env.PERF_LABEL || 'run';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A second connection to any page of the instance (the editor window as well as the Agents window). */
async function open(port, t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, close: () => ws.close() };
}
async function pages(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return list.filter((t) => t.type === 'page').map((t) => ({ t, name: /sessions/.test(t.url) ? 'agents' : /workbench/.test(t.url) ? 'editor' : t.url.slice(0, 40) }));
}

/** "1:02.34" / "1:02:03.45" (ps time) to seconds */
const secs = (t) => t.split(':').reduce((a, p) => a * 60 + Number(p), 0);

function processes(rootPid) {
  const rows = execFileSync('/bin/ps', ['-Ao', 'pid=,ppid=,time=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cpu: secs(m[3]), cmd: m[4] }));
  const under = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) if (!under.has(r.pid) && under.has(r.ppid)) { under.add(r.pid); grew = true; }
  }
  return rows.filter((r) => under.has(r.pid));
}

function kindOf(cmd) {
  if (/--type=renderer/.test(cmd)) return 'renderer';
  if (/--type=gpu-process/.test(cmd)) return 'gpu';
  if (/Helper \(Plugin\).*--type=utility/.test(cmd)) return 'exthost';
  if (/--type=utility/.test(cmd)) return 'utility:' + ((cmd.match(/--utility-sub-type=(\S+)/) || [])[1] || '?');
  if (/Contents\/MacOS\/Dispatch IDE( |$)/.test(cmd) && !/Helper/.test(cmd)) return 'main';
  if (/dispatch\.py|\/dispatch( |$)/.test(cmd)) return 'dispatch-cli';
  return 'other';
}

function cpuByKind(rootPid) {
  const out = {};
  for (const r of processes(rootPid)) {
    const k = kindOf(r.cmd);
    if (k === 'dispatch-cli') continue;
    out[`${k}:${r.pid}`] = r.cpu;
  }
  return out;
}

/** The instance's Dispatch output channel (every `dispatch … → code (ms)` the extension host ran) */
function dispatchRuns(logsRoot) {
  const lines = [];
  const walk = (d) => {
    for (const e of (() => { try { return readdirSync(d, { withFileTypes: true }); } catch { return []; } })()) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/-Dispatch\.log$/.test(e.name)) lines.push(...readFileSync(f, 'utf8').split('\n'));
    }
  };
  walk(logsRoot);
  return lines.filter((l) => /dispatch \S.* → /.test(l));
}

const METRICS = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount'];

function summariseProfile(p) {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const self = new Map();
  let total = 0;
  p.samples.forEach((id, i) => {
    const dt = (p.timeDeltas[i] || 0) / 1000;
    self.set(id, (self.get(id) || 0) + dt);
    total += dt;
  });
  const fn = new Map();
  const file = new Map();
  for (const [id, ms] of self) {
    const cf = byId.get(id).callFrame;
    const key = `${cf.functionName || '(anonymous)'} ${cf.url.replace(/^.*\/out\//, '').replace(/^.*\/src\//, '')}:${cf.lineNumber + 1}`;
    fn.set(key, (fn.get(key) || 0) + ms);
    const fk = cf.url ? cf.url.replace(/^.*\/out\//, '').replace(/^.*\/src\//, '') : cf.functionName;
    file.set(fk, (file.get(fk) || 0) + ms);
  }
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, ms]) => ({ k, ms: Math.round(ms), pct: Math.round((ms / total) * 1000) / 10 }));
  return { totalMs: Math.round(total), functions: top(fn, 25), files: top(file, 15) };
}

/** One measurement of the idle window: MEASURE_S seconds of CPU, main-thread numbers, animations, runs; then the profile. */
async function measure(ui, name, logs, { churn, profile = true } = {}) {
  const result = { name, measureS: MEASURE_S, profileS: PROFILE_S };
  const all = await pages(ui.rec.port);
  const conns = [];
  for (const { t, name: n } of all) {
    const c = await open(ui.rec.port, t);
    await c.send('Performance.enable');
    await c.send('Runtime.evaluate', { expression: `(() => { if (!window.__perfRaf) { window.__perfRaf = { n: 0 }; const o = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (cb) => { window.__perfRaf.n++; return o(cb); }; } return true; })()`, returnByValue: true });
    conns.push({ n, c });
  }
  const read = async (c) => {
    const m = Object.fromEntries((await c.send('Performance.getMetrics')).metrics.filter((x) => METRICS.includes(x.name)).map((x) => [x.name, x.value]));
    const raf = (await c.send('Runtime.evaluate', { expression: 'window.__perfRaf.n', returnByValue: true })).result.value;
    return { m, raf, state: (await c.send('Runtime.evaluate', { expression: '[document.visibilityState, document.hasFocus(), document.body.classList.contains("dispatch-window-idle")].join()', returnByValue: true })).result.value };
  };
  const cpu0 = cpuByKind(ui.rec.pid);
  const before = await Promise.all(conns.map(({ c }) => read(c)));
  const runs0 = dispatchRuns(logs).length;
  const t0 = Date.now();
  const stop = churn ? churn() : () => undefined;
  await sleep(MEASURE_S * 1000);
  stop();
  const wall = (Date.now() - t0) / 1000;
  const cpu1 = cpuByKind(ui.rec.pid);
  const after = await Promise.all(conns.map(({ c }) => read(c)));
  const slice = dispatchRuns(logs).slice(runs0);
  const perKind = {};
  for (const [k, v] of Object.entries(cpu1)) {
    if (!(k in cpu0)) continue;
    const kind = k.split(':')[0];
    const pct = ((v - cpu0[k]) / wall) * 100;
    perKind[k] = Math.round(pct * 10) / 10;
    result['cpu_' + kind] = Math.round(((result['cpu_' + kind] || 0) + pct) * 10) / 10;
  }
  result.cpuPerProcessPct = perKind;
  result.windows = {};
  conns.forEach(({ n }, i) => {
    const d = (k) => after[i].m[k] - before[i].m[k];
    result.windows[n] = {
      state: after[i].state, // visibilityState, hasFocus, idle class
      mainBusyPct: Math.round((d('TaskDuration') / wall) * 1000) / 10,
      scriptMs: Math.round(d('ScriptDuration') * 1000), layoutMs: Math.round(d('LayoutDuration') * 1000), styleMs: Math.round(d('RecalcStyleDuration') * 1000),
      layoutsPerSecond: Math.round(d('LayoutCount') / wall), stylesPerSecond: Math.round(d('RecalcStyleCount') / wall),
      rafPerSecond: Math.round(((after[i].raf - before[i].raf) / wall) * 10) / 10,
    };
  });
  result.dispatchRunsPerMinute = Math.round((slice.length / wall) * 600) / 10;
  const byCmd = {};
  for (const l of slice) { const c = (l.match(/dispatch (\S+(?: \S+)?)/) || [])[1]; byCmd[c] = (byCmd[c] || 0) + 1; }
  result.dispatchRunsByCommand = Object.fromEntries(Object.entries(byCmd).sort((a, b) => b[1] - a[1]));
  result.animations = {};
  for (const { n, c } of conns) {
    const r = await c.send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
      const out = {};
      for (const a of document.getAnimations()) {
        const name = a.animationName || a.transitionProperty || a.constructor.name;
        const t = a.effect && a.effect.target;
        const cls = t ? (t.className && t.className.baseVal !== undefined ? t.className.baseVal : String(t.className)).split(' ').slice(0, 3).join('.') : '?';
        const key = name + ' on ' + (t ? t.tagName.toLowerCase() : '?') + '.' + cls + ' [' + a.playState + ']';
        out[key] = (out[key] || 0) + 1;
      }
      return out;
    })()` });
    result.animations[n] = r.result.value;
  }
  result.profiles = {};
  for (const { n, c } of profile ? conns : []) {
    await c.send('Profiler.enable');
    await c.send('Profiler.setSamplingInterval', { interval: 1000 });
    await c.send('Profiler.start');
    await sleep(PROFILE_S * 1000);
    const { profile } = await c.send('Profiler.stop');
    result.profiles[n] = summariseProfile(profile);
  }
  conns.forEach(({ c }) => c.close());
  return result;
}

export default async function (ui) {
  await ui.openAgents(ui.demoFolder).catch(() => ui.openAgents());
  try {
    const { windowId } = await ui.cdp.send('Browser.getWindowForTarget');
    await ui.cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -3000, top: -3000, width: 1440, height: 900 } });
  } catch { /* stays where it is */ }
  await ui.waitFor({ css: '.dispatch-status-bar' }, { timeoutMs: 30000 * SCALE });
  await ui.newSession().catch(() => undefined);
  await ui.screenshot('perf-layout');
  await sleep(25000 * SCALE); // the first asks of every poller are over

  const logs = join(ui.rec.root, 'user-data', 'logs');
  const out = { label: LABEL, build: ui.rec.build && ui.rec.build.kanban, phases: [] };
  // other Agents writing the board all night (a log line every 1.5 s, as ten of them do): each change used to start
  // one `dispatch` read per view
  const bin = join(ui.rec.bin_dir, 'dispatch');
  let churnId = '';
  try {
    churnId = JSON.parse(execFileSync(bin, ['begin', 'Perf churn: other agents write the board while the window sits', '-P', 'demo', '-d', 'Several agents log to the board all night; the window must not start the CLI for each one.', '--json'], { encoding: 'utf8', timeout: 60000 })).id;
  } catch (e) { out.churnError = String(e).slice(0, 300); }
  const churn = () => {
    if (!churnId) return () => undefined;
    let n = 0, on = true;
    (async () => { while (on) { try { await promisify(execFile)(bin, ['log', churnId, 'tick ' + (++n)], { timeout: 30000 }); } catch { /* the next one */ } await sleep(1500); } })();
    return () => { on = false; };
  };
  // 1. the window as the runner keeps it: focused (a person at the keyboard, or watching it)
  out.phases.push(await measure(ui, 'focused', logs));
  out.phases.push(await measure(ui, 'focused+board-churn', logs, { churn, profile: false }));
  // 2. nobody there: the OS says blur (the runner keeps the Agents window focused for its clicks), untouched
  await ui.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined);
  for (const { t } of await pages(ui.rec.port)) {
    const c = await open(ui.rec.port, t);
    await c.send('Runtime.evaluate', { expression: `window.dispatchEvent(new Event('blur'))` });
    c.close();
  }
  await sleep(45000 * SCALE);
  out.phases.push(await measure(ui, 'unfocused', logs));
  out.phases.push(await measure(ui, 'unfocused+board-churn', logs, { churn, profile: false }));

  writeFileSync(join(ui.out, `perf-idle-${LABEL}.json`), JSON.stringify(out, null, 1));
  for (const ph of out.phases) {
    console.log('PERF ' + ph.name + ' ' + JSON.stringify({ renderer: ph.cpu_renderer, gpu: ph.cpu_gpu, exthost: ph.cpu_exthost, main: ph.cpu_main, runsPerMin: ph.dispatchRunsPerMinute, windows: ph.windows }));
  }
}
