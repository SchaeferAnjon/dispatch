// The task board's changes are pushed (app/cli/board_service.py in chatd, app/ide-ext/src/board.ts,
// Dispatch IDE patches/430-tasks.patch): something an Agent hands you shows up on Waiting for
// you at once (its timer is 5 s and stays, for sessions), and a window left alone no longer starts bd.
// Works on an older build too (no board service): then it only measures, for the before/after numbers.
// Real pointer on the instance's demo project; no engine messages.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const meta = {
  title: '任务板推送：新事项立刻出现，闲着不再轮询',
  description: 'Agent 用 dispatch need-you 交给你的事立刻出现在 Waiting for you；窗口闲着 30 秒时数一数界面跑了几次 dispatch、起了几个 bd。',
};

const IDLE_MS = 30000;

function cliEnv(rec) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(VSCODE_|ELECTRON_|CLAUDE_CODE_|DISPATCH_|BEADS_|CODEX_THREAD|CODEX_SESSION)/.test(key) && key !== 'CLAUDECODE') env[key] = value;
  }
  return Object.assign(env, { BEADS_DIR: rec.beads_dir, DISPATCH_DIR: rec.dispatch_dir, DISPATCH_HOME: rec.dispatch_home, DISPATCH_BIN: rec.cli,
    DISPATCH_E2E_INSTANCE: rec.name, PATH: `${path.join(rec.app, 'Contents/Resources/app/tools')}:${process.env.PATH}` });
}

function cli(ui, args, check = true) {
  const r = spawnSync('python3', [ui.rec.cli, ...args], { env: cliEnv(ui.rec), cwd: ui.demoFolder, encoding: 'utf8', timeout: 120000 });
  if (check && r.status !== 0) throw new Error(`dispatch ${args.slice(0, 2).join(' ')}: ${r.stderr || r.stdout}`);
  return r;
}

/** Every dispatch-bridge log ("Dispatch" output channel) of this instance, newest last. */
function bridgeLogs(rec) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p, depth + 1);
      else if (/-Dispatch\.log$/.test(d.name)) found.push(p);
    }
  };
  for (const d of [rec.user_data_dir, rec.agents_user_data_dir].filter(Boolean)) walk(path.join(d, 'logs'), 0);
  return found;
}

/** The CLI runs the bridge logged: `dispatch <cmd …> → <code> (<ms> ms)`. */
function cliRuns(rec) {
  const runs = [];
  for (const f of bridgeLogs(rec)) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = /^(\d\d:\d\d:\d\d\.\d+) dispatch (.+?) → (\S+)(?: \((\d+) ms\))?$/.exec(line);
      if (m) runs.push({ file: f, at: m[1], cmd: m[2].split(' ').slice(0, 2).join(' '), ms: m[4] ? Number(m[4]) : null });
    }
  }
  return runs;
}

function chatdPid(rec) {
  try { return JSON.parse(fs.readFileSync(path.join(rec.dispatch_dir, 'chatd.json'), 'utf8')).pid || 0; } catch { return 0; }
}

/** bd and dispatch processes under the app and the instance's chatd, sampled every 200 ms. */
function sampler(rec) {
  const seenBd = new Set();
  const seenCli = new Set();
  let peakBd = 0;
  let stop = false;
  const tick = () => {
    if (stop) return;
    const out = spawnSync('ps', ['-Ao', 'pid=,ppid=,comm=,args='], { encoding: 'utf8' }).stdout;
    const rows = new Map();
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
      if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3], args: m[4] });
    }
    const roots = new Set([rec.pid, chatdPid(rec)].filter(Boolean));
    let bd = 0;
    for (const [pid, r] of rows) {
      let p = r.ppid, ours = false;
      for (let i = 0; i < 12 && p > 1; i++) { if (roots.has(p)) { ours = true; break; } p = rows.get(p)?.ppid ?? 0; }
      if (!ours) continue;
      const exe = (r.args.split(' ')[0] || r.comm).split('/').pop(); // ps cuts comm at 16 characters
      if (exe === 'bd' && !/send-metrics/.test(r.args)) { bd++; seenBd.add(pid); }
      else if (/dispatch\.py/.test(r.args) && !/chatd run/.test(r.args)) seenCli.add(pid);
    }
    peakBd = Math.max(peakBd, bd);
    setTimeout(tick, 200);
  };
  tick();
  return { done: () => { stop = true; return { bd_seen: seenBd.size, dispatch_seen: seenCli.size, peak_bd: peakBd }; } };
}

function serviceStats(ui) {
  const r = cli(ui, ['board', 'stats', '--json'], false);
  try { const j = JSON.parse(r.stdout); return j.running ? j.stats : null; } catch { return null; }
}

/** Close the first-run tour card ("1 of 3") with its own close button, as often as one comes up. */
async function closeTour(ui) {
  for (let i = 0; i < 4; i++) {
    const tagged = await ui.eval(`(() => { const card = [...document.querySelectorAll('div')].find(d => /^\\d of \\d$/m.test(d.innerText || '') && d.querySelector('[aria-label="Close"], .codicon-close, .codicon-x') && d.innerText.length < 400); const x = card && card.querySelector('[aria-label="Close"], .codicon-close, .codicon-x'); if (x) x.setAttribute('data-e2e-tour-close', '1'); return !!x; })()`);
    if (!tagged) return;
    await ui.click({ css: '[data-e2e-tour-close="1"]' });
    await ui.sleep(500);
  }
}

export default async function (ui) {
  const rec = ui.rec;
  const report = { app: rec.app, build: rec.build, checks: [] };
  // Waiting for you lists what only you can do from the board (any build opens straight into it)
  await ui.openAgents();
  // a first-run tour card ("1 of 3") may sit over the page: close it with its own close button
  await closeTour(ui);
  // the side bar may still be laying its rows out (a busy Mac): the click can land on the row above; click again
  for (let i = 0; i < 3 && !(await ui.exists({ css: '.dispatch-waiting-a' })); i++) {
    await ui.click({ text: 'Waiting for you', exact: true, within: '.part.sidebar' });
    for (let j = 0; j < 20 && !(await ui.exists({ css: '.dispatch-waiting-a' })); j++) await ui.sleep(500);
  }
  await ui.waitFor({ css: '.dispatch-waiting-a' }, { timeoutMs: 60000 });
  await ui.waitFor({ text: 'Approve the demo release', within: '.dispatch-waiting-a' }, { timeoutMs: 60000 });

  // a new build starts chatd (and its board service) by itself a few seconds after the window opens
  let stats = null;
  for (let i = 0; i < 45 && !stats; i++) { stats = serviceStats(ui); if (!stats) await ui.sleep(1000); }
  report.service = !!stats;
  if (stats) {
    const live = () => bridgeLogs(rec).some((f) => fs.readFileSync(f, 'utf8').includes('board: watching changes'));
    for (let i = 0; i < 30 && !live(); i++) await ui.sleep(1000);
    report.live = live();
    if (!report.live) throw new Error('the board service runs but the window is not watching its changes');
    report.checks.push('the window watches the board service');
  }
  await ui.sleep(5000); // let the first round of the window's own reads finish

  // 1. a window left alone for 30 s
  const runs0 = cliRuns(rec).length;
  const s0 = stats ? serviceStats(ui) : null;
  const sample = sampler(rec);
  await ui.sleep(IDLE_MS);
  const proc = sample.done();
  const idleRuns = cliRuns(rec).slice(runs0);
  const s1 = stats ? serviceStats(ui) : null;
  const byCmd = {};
  for (const r of idleRuns) byCmd[r.cmd] = (byCmd[r.cmd] || 0) + 1;
  report.idle = { seconds: IDLE_MS / 1000, dispatch_runs: idleRuns.length, by_command: byCmd, ...proc,
    service_bd_started: s1 && s0 ? s1.bd_started - s0.bd_started : null,
    ms: idleRuns.map((r) => r.ms).filter((x) => x !== null) };
  const boardOnly = (byCmd['task list'] || 0) + (byCmd['projects --sidebar'] || 0) + (byCmd['projects --json'] || 0);
  if (stats && boardOnly > 0) throw new Error(`a board-only view still polls: ${JSON.stringify(byCmd)} in ${IDLE_MS / 1000} s`);
  if (stats) report.checks.push(`idle ${IDLE_MS / 1000} s: no board-only view polled, ${idleRuns.length} dispatch runs, ${proc.bd_seen} bd processes`);

  // 2. an Agent hands you something only you can do: how long until the window counts it (the number on
  //    the Waiting for you row) and lists it on the page
  const count = () => ui.eval(`(() => { const row = [...document.querySelectorAll('.part.sidebar .monaco-list-row, .part.sidebar [role="treeitem"], .part.sidebar a, .part.sidebar div')].find(e => /^Waiting for you\\s*\\n?\\s*\\d*$/.test((e.innerText || '').trim())); const m = row && /(\\d+)\\s*$/.exec(row.innerText.trim()); return m ? Number(m[1]) : 0; })()`);
  const ROUNDS = 5;
  const rounds = [];
  let title = '';
  let id = '';
  for (let k = 0; k < ROUNDS; k++) {
    await ui.sleep(1500 + Math.round(Math.random() * 4000)); // land anywhere between two polls
    const before = await count();
    title = `Pushed to the window at once ${Date.now() % 100000}`;
    const t0 = Date.now();
    const made = cli(ui, ['need-you', title, '-P', 'demo', '-d', 'Made by the board-push e2e scenario: it should show up without waiting for the next poll.', '--json']);
    const cliMs = Date.now() - t0;
    id = (/"(task-[a-z0-9]+)"/.exec(made.stdout) || [])[1] || id;
    const t1 = Date.now();
    let counted = null;
    while (Date.now() - t1 < 45000) {
      if ((await count()) > before) { counted = Date.now() - t1; break; }
      await ui.sleep(100);
    }
    if (counted === null) throw new Error('the Waiting for you number did not go up in 45 s');
    rounds.push({ cli_ms: cliMs, counted_after_ms: counted });
  }
  const after = rounds.map((r) => r.counted_after_ms);
  report.new_task = { id, rounds, mean_ms: Math.round(after.reduce((a, b) => a + b, 0) / after.length), max_ms: Math.max(...after) };
  report.load = (await import("node:os")).loadavg().map((x) => Math.round(x));
  report.checks.push(`${ROUNDS} new items: the Waiting for you number goes up ${report.new_task.mean_ms} ms (at most ${report.new_task.max_ms} ms) after dispatch need-you returned`);
  if (!(await ui.exists({ css: '.dispatch-waiting-a' }))) await ui.click({ text: 'Waiting for you', exact: true, within: '.part.sidebar' });
  await ui.waitFor({ text: title, within: '.dispatch-waiting-a' }, { timeoutMs: 45000 });
  await closeTour(ui); // a later step of the first-run tour may have come up meanwhile
  await ui.screenshot('waiting-new-item');
  await ui.mark({ text: 'Waiting for you', exact: true, within: '.part.sidebar' }, { what: '有事等你时的数字', where: '左栏 Sessions 下第一行', how: '任务板一变就加一，不等下一次刷新' });
  await ui.mark({ text: title, within: '.dispatch-waiting-a' }, { what: '刚由 Agent 交给你的事', where: 'Waiting for you 页，Only you 分组', how: 'Agent 跑 dispatch need-you 后自己出现' });

  // 3. a progress note on it: the board service tells the window, the row is refreshed
  const t2 = Date.now();
  if (id) cli(ui, ['log', id, 'first step done']);
  report.log_cli_ms = Date.now() - t2;
  report.service_stats = stats ? serviceStats(ui) : null;
  fs.writeFileSync(path.join(ui.out, 'board-push.json'), JSON.stringify(report, null, 2));
}
