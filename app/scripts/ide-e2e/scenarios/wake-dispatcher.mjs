// Worker state changes wake an Agents window dispatcher (chatd delivers a message into its session).
// Run on a disposable instance. The dispatcher is an OpenCode session on deepseek/deepseek-flash that
// chatd holds (`agent start opencode`); the Agents window's own OpenCode sessions are not chatd's. Workers are stand-ins the scenario controls, so no real model is billed
// for them: `worker adopt` registers a sleeping process, and the scenario decides when it ends.
//   ok worker   : report written, process ends       -> "已交回"
//   busy worker : same, but while the dispatcher is answering a long request -> message is queued
//   bad worker  : codex worker that exits without a report; chatd restarts it twice (on a model Codex does not
//                 have, so each restart fails at once and spends nothing, quota or not), then needs-you
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir } from 'node:fs/promises';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)
const exec = promisify(execFile);
export const meta = { needs: ['opencode'], timeout: 1500, title: 'Worker wake-up in an Agents dispatcher session', description: 'A worker hands back or dies; chatd delivers the news into the dispatcher session, queued behind a running turn.' };

async function until(ui, fn, what, ms = 240000) {
  const end = Date.now() + ms * SCALE;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await ui.sleep(1000);
  }
  throw new Error(`Timed out: ${what}`);
}

async function notes(ui) {
  const base = `${ui.rec.dispatch_dir}/notifications`;
  const out = [];
  for (const [dir, state] of [[base, 'unread'], [`${base}/read`, 'read']]) {
    let names = [];
    try { names = await readdir(dir); } catch { /* none yet */ }
    for (const n of names.filter(x => /^[0-9a-f]{16}\.json$/.test(x))) out.push({ ...JSON.parse(await readFile(`${dir}/${n}`, 'utf8')), state });
  }
  return out.sort((a, b) => a.at_ts - b.at_ts);
}

// The dispatcher is asked to answer "ACK <worker>"; DeepSeek sometimes answers in its own words instead. What
// matters is that it was told and answered about that worker, so its name in the reply counts too.
export default async function (ui) {
  if (!ui.rec.root.startsWith('/tmp/dide-e2e/') && !ui.rec.root.startsWith('/private/tmp/dide-e2e/')) throw new Error('Disposable instance required');
  const env = { ...process.env, BEADS_DIR: ui.rec.beads_dir, DISPATCH_DIR: ui.rec.dispatch_dir,
    DISPATCH_HOME: ui.rec.dispatch_home, CODEX_HOME: `${ui.rec.root}/codex-home`,
    // the instance's OpenCode store, where chatd's OpenCode keeps the dispatcher's conversation (`agent read` reads it there)
    XDG_DATA_HOME: `${ui.rec.root}/xdg-data`, XDG_CONFIG_HOME: `${ui.rec.root}/xdg-config`,
    DISPATCH_IDE_USER_DATA_DIRS: `${ui.rec.user_data_dir}:${ui.rec.agents_user_data_dir}`,
    DISPATCH_SESSION_ROOT: ui.rec.root, CODEX_THREAD_ID: '', CLAUDE_SESSION_ID: '', DISPATCH_SESSION_ID: '', BEADS_ACTOR: 'opencode' };
  // The shared machine can be slow enough for a board read to time out; a command is retried a few times.
  const cli = async (args, more = {}) => {
    for (let attempt = 1; ; attempt++) {
      try { return (await exec(ui.rec.cli, args, { env: { ...env, ...more }, timeout: 90000, maxBuffer: 4e6 })).stdout; }
      catch (e) { if (attempt >= 4 || !/timed out|Timed out/.test(String(e.stderr || e.message))) throw e; await ui.sleep(3000); }
    }
  };
  const evidence = { timeline: [] };
  const tag = Date.now().toString(36);
  const names = { ok: `wake-ok-${tag}`, busy: `wake-busy-${tag}`, bad: `wake-bad-${tag}` };
  // the evidence goes in the run's folder as it grows (the instance's folder is cleared by the next instance)
  const stamp = what => { evidence.timeline.push({ at: new Date().toISOString(), what }); writeFile(`${ui.out}/wake-evidence.json`, JSON.stringify(evidence, null, 2)).catch(() => undefined); };

  // 1. The dispatcher: an OpenCode session that chatd holds (the Agents window lists it with the others).
  const started = JSON.parse(await cli(['agent', 'start', 'opencode', '--cwd', ui.demoFolder, '--model', 'deepseek/deepseek-flash', '--label', 'wake dispatcher',
    '-p', 'This is an isolated wake-up test. Never use tools and never run commands. When a message starts with the word worker, reply with exactly ACK followed by the worker name. Otherwise, when asked to count, just write the numbers. Reply READY now.',
    '--timeout', '180', '--json']));
  if (!/READY/.test(started.output || '')) throw new Error('Dispatcher did not answer: ' + JSON.stringify(started));
  const key = started.session;
  const sid = key.split(':').at(-1);
  const reg = async () => JSON.parse(await readFile(`${ui.rec.dispatch_dir}/chatd.json`, 'utf8'));
  const held = (await reg()).sessions[key];
  if (!held) throw new Error('chatd does not hold the session');
  const pid = held.pid || (await reg()).pid;   // OpenCode has no process of its own here: chatd's pid stands for it
  evidence.dispatcher = { key, pid, chatdOwnsPid: !held.pid };
  const read = async () => (await cli(['agent', 'read', key, '--lines', '400'])).toString();
  const readUntil = async (pattern, what, ms = 180000) => until(ui, async () => { const t = await read(); return pattern.test(t) && t; }, what, ms);
  const status = async () => JSON.parse(await cli(['agent', 'list', '--json'])).find(x => x.session === key)?.status;

  // 2. Register it as the dispatcher (a real claim from this session's process), and let chatd take its baseline.
  const previous = JSON.parse(await cli(['dispatcher', 'show']));
  if (previous.active) await cli(['dispatcher', 'release', '--session', previous.session, '--reason', 'new test run']);
  const claim = JSON.parse(await cli(['dispatcher', 'claim', '--session', sid, '--pid', String(pid), '--engine', 'opencode', '--json']));
  if (!claim.active || claim.engine !== 'opencode') throw new Error('Claim failed: ' + JSON.stringify(claim));
  await cli(['worker', 'wait', '--timeout', '1']);
  const task = JSON.parse(await cli(['begin', 'Wake test: workers hand back to the window dispatcher', '-P', 'demo',
    '-d', 'A worker ends; the dispatcher session must be told without asking. Expect delivered messages.', '--thing', 'Wake-up', '--force', '--json']));
  const taskId = task.id || task.task?.id || task.task;
  const task2 = JSON.parse(await cli(['begin', 'Wake test: a worker that dies without a report', '-P', 'demo',
    '-d', 'The worker exits with no report; expect failed, two restarts and a need-you.', '--thing', 'Wake-up', '--force', '--json']));
  const badTask = task2.id || task2.task?.id || task2.task;
  const brief = `${ui.rec.root}/wake-brief.md`;
  await writeFile(brief, 'Stand-in brief for the wake-up test.\n');
  const folder = ui.demoFolder;
  const stand = () => { const p = spawn('sleep', ['900'], { detached: true, stdio: 'ignore' }); p.unref(); return p.pid; };
  const adopt = async (name, task, engine, pid, report) => cli(['worker', 'adopt', name, '--task', task, '--engine', engine, '--model', engine === 'codex' ? 'gpt-e2e-no-such-model' : 'deepseek/deepseek-flash',
    '--cwd', folder, '--brief', brief, '--pid', String(pid), '--report', report, '--log', report + '.log', '--json']);

  // 3. A worker hands back while the dispatcher is idle: the message arrives at once.
  const okReport = `${ui.rec.root}/wake-ok-${tag}-report.md`;
  const okPid = stand();
  await adopt(names.ok, taskId, 'opencode', okPid, okReport);
  await writeFile(okReport, '# Done\nStand-in report.\n');
  process.kill(okPid, 'SIGTERM');
  stamp('wake-ok exited with a report');
  await until(ui, async () => (await notes(ui)).find(x => x.worker === names.ok && x.state === 'read' && (x.delivered || []).some(d => d.via === 'chatd')), 'chatd delivered the message', 120000);
  stamp('chatd delivered the message into the session');
  await readUntil(new RegExp('ACK\\s*' + names.ok + '|' + names.ok), 'the dispatcher answered it', 120000);

  // 4. A worker hands back while the dispatcher is answering: the message waits for the turn to end.
  const busyReport = `${ui.rec.root}/wake-busy-${tag}-report.md`;
  const busyPid = stand();
  await adopt(names.busy, taskId, 'opencode', busyPid, busyReport);
  await cli(['agent', 'ask', key, 'Count from 1 to 3000, one number per line, then write DONE-COUNT. Do not use tools.', '--no-wait']);
  await until(ui, async () => { const st = await status(); return st && st !== 'idle'; }, 'the long turn started', 30000);
  await writeFile(busyReport, '# Done\nStand-in report.\n');
  process.kill(busyPid, 'SIGTERM');
  stamp('wake-busy exited while the turn runs');
  let busyAtDelivery = null;
  await until(ui, async () => {
    const n = (await notes(ui)).find(x => x.worker === names.busy);
    const st = await status();
    evidence.timeline.push({ at: new Date().toISOString(), what: 'poll', state: n?.state || 'none', session: st });
    if (n?.state === 'read' && busyAtDelivery === null) busyAtDelivery = st;
    return n?.state === 'read' && st === 'idle';
  }, 'queued message delivered after the turn', 300000);
  evidence.sessionStateWhenQueued = busyAtDelivery;
  await readUntil(new RegExp('ACK\\s*' + names.busy + '|' + names.busy), 'the dispatcher answered the queued message', 420000);
  if (!busyAtDelivery || busyAtDelivery === 'idle') throw new Error('The message was not queued behind a running turn: ' + busyAtDelivery);

  // 5. A worker dies without a report: failed, restarted twice (codex has no quota here), then needs-you.
  const badReport = `${ui.rec.root}/wake-bad-${tag}-report.md`;
  const badPid = stand();
  await adopt(names.bad, badTask, 'codex', badPid, badReport);
  process.kill(badPid, 'SIGTERM');
  stamp('wake-bad exited without a report');
  const events = new Set();
  await until(ui, async () => {
    for (const n of await notes(ui)) if (n.worker === names.bad) events.add(n.event);
    return ['failed', 'restarted', 'need-you'].every(e => events.has(e)) && (await notes(ui)).every(n => n.state === 'read');
  }, 'failed, restarted and need-you notifications, all delivered', 420000);
  await readUntil(new RegExp('ACK\\s*' + names.bad + '|' + names.bad), 'the dispatcher answered the failure chain', 120000);
  await until(ui, async () => (await status()) === 'idle', 'the dispatcher settled', 180000);

  // 6. Evidence from disk.
  evidence.notifications = (await notes(ui)).filter(n => n.worker.endsWith(tag));  // this run's; an aborted earlier run may have left others
  evidence.needYou = JSON.parse(await cli(['task', 'list', '-P', 'demo', '--json']));
  const unread = evidence.notifications.filter(n => n.state === 'unread');
  if (unread.length) throw new Error('Unread notifications left: ' + unread.map(n => n.text).join(' | '));
  for (const n of evidence.notifications.filter(x => x.read_by !== 'baseline')) {
    if (!(n.delivered || []).some(d => d.via === 'chatd')) throw new Error('Not delivered by chatd: ' + n.text);
  }
  await writeFile(`${ui.out}/wake-evidence.json`, JSON.stringify(evidence, null, 2));
}
