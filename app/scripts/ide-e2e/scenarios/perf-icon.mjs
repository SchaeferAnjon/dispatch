// Which way of drawing the icon's breathing dot is cheap (task: Dispatch eats CPU while idle). The editor window has
// nothing else running, so its style and layout counts are the dot's. Each variant is put on the live page as a style
// and measured for VARIANT_S seconds; result: perf-icon.json.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const meta = { title: 'Icon breath cost', description: 'Style and layout work per second for ways of animating the icon dot.', instance: { motion: true }, timeout: 600 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VARIANT_S = Number(process.env.VARIANT_S || 8);

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


const V = {
  v0_current: '',
  v1_none: '.dispatch-icon .now { animation: none !important; }',
  v2_willchange: '.dispatch-icon .now { will-change: transform, opacity; }',
  v3_opacity_only: '.dispatch-icon .now { animation-name: dpf-op !important; } @keyframes dpf-op { 0%,100% { opacity: 1 } 50% { opacity: .4 } }',
  v4_steps30: '.dispatch-icon .now { animation-timing-function: steps(30) !important; }',
  v5_steps12: '.dispatch-icon .now { animation-timing-function: steps(12) !important; }',
  v6_viewbox_origin: '.dispatch-icon .now { transform-box: view-box !important; transform-origin: var(--dpf-ox) var(--dpf-oy) !important; }',
};

export default async function (ui) {
  await ui.openAgents(ui.demoFolder).catch(() => ui.openAgents());
  await sleep(15000);
  const all = await pages(ui.rec.port);
  const conns = [];
  for (const { t, name } of all) { const c = await open(ui.rec.port, t); await c.send('Performance.enable'); conns.push({ name, c }); }
  const ev = async (c, expression) => (await c.send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  const res = {};
  for (const [name, css] of Object.entries(V)) {
    for (const { c } of conns) {
      await ev(c, `(() => { document.getElementById('dpf')?.remove(); const st = document.createElement('style'); st.id = 'dpf'; const dot = document.querySelector('.dispatch-icon .now circle'); const ox = dot ? dot.getAttribute('cx') + 'px' : '50%', oy = dot ? dot.getAttribute('cy') + 'px' : '50%'; st.textContent = ':root { --dpf-ox: ' + ox + '; --dpf-oy: ' + oy + '; } ' + ${JSON.stringify(css)}; document.head.appendChild(st); })()`);
    }
    await sleep(1500);
    const read = async (c) => Object.fromEntries((await c.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
    const m0 = await Promise.all(conns.map(({ c }) => read(c)));
    const t0 = Date.now();
    await sleep(VARIANT_S * 1000);
    const wall = (Date.now() - t0) / 1000;
    const m1 = await Promise.all(conns.map(({ c }) => read(c)));
    res[name] = {};
    conns.forEach(({ name: w }, i) => {
      res[name][w] = { layoutPerS: Math.round((m1[i].LayoutCount - m0[i].LayoutCount) / wall), stylePerS: Math.round((m1[i].RecalcStyleCount - m0[i].RecalcStyleCount) / wall), taskMsPerS: Math.round(((m1[i].TaskDuration - m0[i].TaskDuration) / wall) * 1000) };
    });
    console.log('ICON', name, JSON.stringify(res[name]));
  }
  writeFileSync(join(ui.out, 'perf-icon.json'), JSON.stringify(res, null, 1));
  conns.forEach(({ c }) => c.close());
}
