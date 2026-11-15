// Dispatch's MCP server, the way agents work with the board (kanban app/cli/dispatch_mcp.py, task-yb4c): in the
// Agents window a Codex session (default permissions, no approval asked) and an OpenCode session each start a task,
// log on it and remember a preference through the dispatch tools, and the instance's board has all three, signed by
// that agent and tied to its session. The preference shows as the Remembered line, as `dispatch prefs add` did.
// CLAUDE=1 also has Claude Code do the same once, from `claude -p` with the server and its allow rule as
// registration writes them (Claude in the Agents window reads the person's own ~/.claude.json, which a test instance
// does not change).
// Test models: Codex a small one when the account has it, OpenCode MCP_OPENCODE_MODEL (default a free flash model), Claude Haiku.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)
const exec = promisify(execFile);

export const meta = { needs: ['codex', 'opencode'],
  title: 'Dispatch tools: Codex and OpenCode write the board through the MCP server',
  description: 'Each engine starts a task, logs on it and remembers a preference with the dispatch tools; the instance board has them, signed by that engine; nothing asks for approval.',
  timeout: 1500,
};
const fresh = '.sessions-chat-editor';
const MARK = `MCP${Date.now().toString(36).toUpperCase()}`;

async function until(ui, fn, what, ms = 240000) {
  const end = Date.now() + ms * SCALE;
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() > end) throw new Error(`Timed out: ${what}`);
    await ui.sleep(2000);
  }
}
const lastAnswer = ui => ui.eval(`(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return r && !r.classList.contains('chat-response-loading') ? r.innerText : ''; })()`);
const pending = ui => ui.eval(`/confirmation pending/i.test(document.body.innerText)`);

function env(ui) {
  return { ...process.env, BEADS_DIR: ui.rec.beads_dir, DISPATCH_DIR: ui.rec.dispatch_dir, DISPATCH_HOME: ui.rec.dispatch_home,
    DISPATCH_SESSION_ROOT: ui.rec.root, CODEX_THREAD_ID: '', DISPATCH_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', BEADS_ACTOR: 'test' };
}
async function cli(ui, args) {
  return (await exec(ui.rec.cli, args, { env: env(ui), timeout: 120000, maxBuffer: 8e6 })).stdout;
}

/** What the instance's board says about the work of one engine: its task, the log line on it, the preference. */
async function board(ui, engine) {
  const tasks = JSON.parse(await cli(ui, ['task', 'list', '-P', 'demo', '--days', '0', '--json'])).tasks || [];
  // the engine's own task: Dispatch may have noted the person's message as a task already, which the engine's
  // task_begin then takes over under the noted title, and it shortens a long title
  const task = tasks.find(t => t.agent === AGENT[engine] && ((t.title || '').includes(MARK) || (t.title || '').includes(TOPIC[engine])));
  if (!task) return { task: null };
  const shown = JSON.parse(await cli(ui, ['task', 'show', task.id, '--json']));
  const comments = (await exec('bd', ['comments', task.id], { env: { ...env(ui), PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}` }, timeout: 60000 }).catch(() => ({ stdout: '' }))).stdout;
  const prefs = JSON.parse(await cli(ui, ['prefs', 'list', '--json']));
  const pref = (prefs.items || []).find(p => (p.text || '').includes(`${MARK} ${engine}`));
  return { task: { id: task.id, title: task.title, agent: shown.agent, session: shown.session, sessions: shown.sessions },
           logged: comments.includes(`${MARK} ${engine} log`), pref: pref ? { id: pref.id, text: pref.text, engine: pref.said?.engine, session: pref.said?.session } : null };
}

// a different piece of work for each engine: Dispatch folds a task that looks like one already noted into that one
const TOPIC = { Codex: 'Footer link colour', OpenCode: 'Onboarding tooltip copy', Claude: 'Empty state wording' };
const AGENT = { Codex: 'codex', OpenCode: 'opencode', Claude: 'claude-code' };
// and a different preference: Dispatch folds one that says the same as one it has into that one
const LIKE = { Codex: 'buttons use square corners', OpenCode: 'tooltips end with a full stop', Claude: 'empty states suggest one next step' };

function ask(engine) {
  return `Use Dispatch's tools only (no shell commands, do not edit files). 1) task_begin with title "${TOPIC[engine]} ${MARK}: ${engine} writes the board", ` +
    `project "demo", description "${engine} checks that Dispatch's tools write the board under default permissions (${MARK})". ` +
    `2) task_log on that task with text "${MARK} ${engine} log". 3) prefs_add with sentence "${MARK} ${engine}: ${LIKE[engine]}", ` +
    `kind like, quote "${LIKE[engine]} please". Then reply with the task id only.`;
}

async function clearInput(ui) {
  // what a slash command left in the box (/model after the model was picked) would run into the message
  await ui.click({ css: fresh });
  await ui.press('End');
  const left = await ui.eval(`(document.querySelector('${fresh} .view-lines')?.innerText || '').replace(/\\u00a0/g, ' ').trim().length`);
  for (let i = 0; i < Math.min(left + 2, 400); i++) await ui.press('Backspace');
}

async function sendAndWait(ui, text, shot, engine) {
  await clearInput(ui);
  await ui.type(text);
  await ui.press('Enter', { send: true });
  let asked = false;
  // the reply names the task by its title (the window links task ids), so what counts is the board and a reply that ended
  const work = await until(ui, async () => {
    if (await pending(ui)) asked = true;  // a confirmation would mean the tools are not trusted: record it, never click it
    if (!(await lastAnswer(ui))) return false;
    const b = await board(ui, engine);
    return b.task && b.logged && b.pref && b;
  }, `${shot}: the work on the board and the reply`, 420000).catch(async e => ({ ...(await board(ui, engine)), error: e.message }));
  await ui.sleep(1500);
  await ui.screenshot(shot);
  return { asked, work };
}

/** The new session's model picker (the chip next to the mode) on the first model whose name matches one of `wants`;
 *  the name it shows after. Leaves the model as it is when none is offered. */
async function pickModel(ui, wants) {
  const chip = '.model-picker-item';
  if (!(await ui.exists({ css: chip }))) return '';
  const now = async () => ui.eval(`document.querySelector('${chip}')?.innerText.trim() || ''`);
  const shown = await now();
  if (wants ? wants.some(w => w.test(shown)) : ui.cheapModel([shown])) return shown;
  await ui.click({ css: chip });
  await ui.sleep(1000);
  const rows = await ui.eval(`[...document.querySelectorAll('.context-view .monaco-list-row, .action-widget .monaco-list-row, .action-widget li')].map(e => (e.innerText || '').trim().split('\\n')[0])`);
  const pick = wants ? wants.map(w => rows.find(r => w.test(r))).find(Boolean) : ui.cheapModel(rows);
  if (pick) await ui.click({ text: pick, exact: true, within: '.context-view, .action-widget' });
  else await ui.press('Escape');
  await ui.sleep(1000);
  return now();
}

async function codexConfig(ui, evidence) {
  // the instance's Codex: a cheap model, and the build's dispatch server (instance start wrote it; checked here)
  const home = ui.rec.fixture_home ? path.join(ui.rec.fixture_home, '.codex') : path.join(ui.rec.root, 'codex-home');
  let config = await readFile(`${home}/config.toml`, 'utf8').catch(() => '');
  evidence.codexConfig = (config.match(/\[mcp_servers\.dispatch\][^\n]*(?:\n(?!\[)[^\n]*)*/) || [''])[0].trim();
  if (!/dispatch\.py", "mcp", "serve", "--agent", "codex"/.test(evidence.codexConfig)) throw new Error('The instance Codex has no dispatch MCP server');
  const model = process.env.MCP_CODEX_MODEL || 'gpt-5.6-luna';
  config = config.replace(/^model\s*=.*$/m, `model = "${model}"`).replace(/^model_reasoning_effort\s*=.*$/m, 'model_reasoning_effort = "low"');
  if (!/^model\s*=/m.test(config)) config = `model = "${model}"\nmodel_reasoning_effort = "low"\n` + config;
  await writeFile(`${home}/config.toml`, config);
}

async function codex(ui, evidence) {
  await ui.openAgents(ui.demoFolder);
  await ui.newSession();
  await ui.pickEngine('Codex');
  await ui.sleep(4000);
  evidence.codexModel = await pickModel(ui, [/luna/i, /mini/i]);
  await ui.screenshot('01-codex-new-session');
  ({ asked: evidence.codexAsked, work: evidence.codex } = await sendAndWait(ui, ask('Codex'), '02-codex-reply', 'Codex'));
  evidence.codexRemembered = await ui.exists({ css: '.dispatch-prefs-remembered, .dispatch-prefs-footer' });
}

/** OpenCode's default model in the instance: a cheap one, in the instance's own copy of OpenCode's config (the
 *  person's file stays as it is; the instance links it, so the link is replaced by a copy). Written before the agent
 *  host restarts, which is when OpenCode reads it. */
async function cheapOpenCode(ui, evidence) {
  const cfgDir = ui.rec.fixture_home ? path.join(ui.rec.fixture_home, '.config', 'opencode') : path.join(ui.rec.root, 'xdg-config', 'opencode');
  const cfgFile = path.join(cfgDir, 'opencode.json');
  const model = process.env.MCP_OPENCODE_MODEL || process.env.DISPATCH_E2E_OPENCODE_MODEL || 'opencode/mimo-v2.6-flash-free'; // the free model that answers now (e2e_suite.free_model)
  let cfg = {};
  try { cfg = JSON.parse(await readFile(cfgFile, 'utf8')); } catch { cfg = {}; }
  await rm(cfgFile, { force: true });
  await writeFile(cfgFile, JSON.stringify({ ...cfg, model, small_model: model }, null, 2));
  evidence.opencodeModel = model;
}

async function restartHost(ui) {
  await ui.openAgents(ui.demoFolder);  // the window may not be open yet in a fresh instance
  await ui.attach('agents');
  await ui.step('key', 'F1', async () => {
    await ui.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F1', code: 'F1', windowsVirtualKeyCode: 112 });
    await ui.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F1', code: 'F1', windowsVirtualKeyCode: 112 });
  });
  await ui.type('Developer: Restart Local Agent Host', { into: { css: '.quick-input-widget input' } });
  await ui.press('Enter');
  await ui.sleep(5000);
  await ui.attach('agents', 60000);
}

async function opencode(ui, evidence) {
  await ui.openAgents(ui.demoFolder);
  await ui.newSession();
  await ui.pickEngine('OpenCode');
  await ui.sleep(4000);
  evidence.opencodeModelShown = await pickModel(ui); // the cheap test model (ui.cheapModel)
  await ui.screenshot('03-opencode-new-session');
  ({ asked: evidence.opencodeAsked, work: evidence.opencode } = await sendAndWait(ui, ask('OpenCode'), '04-opencode-reply', 'OpenCode'));
  evidence.opencodeRemembered = await ui.exists({ css: '.dispatch-prefs-remembered, .dispatch-prefs-footer' });
}

async function claude(ui, evidence) {
  // the server and the allow rule exactly as `dispatch mcp register` writes them for Claude Code
  const server = { type: 'stdio', command: 'python3', args: [ui.rec.cli, 'mcp', 'serve', '--agent', 'claude-code'] };
  const cfg = path.join(ui.out, 'claude-mcp.json');
  await writeFile(cfg, JSON.stringify({ mcpServers: { dispatch: server } }));
  const r = await exec('claude', ['-p', '--model', 'haiku', '--permission-mode', 'default', '--mcp-config', cfg, '--strict-mcp-config',
    '--settings', JSON.stringify({ permissions: { allow: ['mcp__dispatch'] } }), ask('Claude')],
    { env: { ...env(ui), CLAUDECODE: '' }, cwd: ui.demoFolder, timeout: 300000, maxBuffer: 8e6 }).catch(e => ({ stdout: e.stdout || '', stderr: String(e.stderr || e.message) }));
  evidence.claudeReply = (r.stdout || '').slice(0, 400);
  evidence.claudeErr = (r.stderr || '').slice(-400);
  evidence.claude = await board(ui, 'Claude');
}

export default async function (ui) {
  if (!ui.rec.root.startsWith('/tmp/dide-e2e/') && !ui.rec.root.startsWith('/private/tmp/dide-e2e/')) throw new Error('Disposable instance required');
  const evidence = { mark: MARK };
  const save = () => writeFile(`${ui.out}/mcp-evidence.json`, JSON.stringify(evidence, null, 2));
  try {
    // both engines read their config when the agent host starts: write them, then restart it once
    if (process.env.MCP_SKIP_OPENCODE !== '1') await cheapOpenCode(ui, evidence);
    if (process.env.MCP_SKIP_CODEX !== '1') await codexConfig(ui, evidence);
    await restartHost(ui);
    if (process.env.MCP_SKIP_CODEX !== '1') await codex(ui, evidence);
    await save();
    if (process.env.MCP_SKIP_OPENCODE !== '1') await opencode(ui, evidence);
    await save();
    if (process.env.CLAUDE === '1') await claude(ui, evidence);
  } finally {
    await save();
  }
  const bad = [];
  for (const [engine, agent] of [['codex', 'codex'], ['opencode', 'opencode'], ['claude', 'claude-code']]) {
    const b = evidence[engine];
    if (!b) continue;
    if (!b.task) bad.push(`${engine}: no task`);
    else {
      if (b.task.agent !== agent) bad.push(`${engine}: task signed ${b.task.agent}`);
      if (!b.task.session) bad.push(`${engine}: task not tied to a session`);
      if (!b.logged) bad.push(`${engine}: no log line`);
      if (!b.pref) bad.push(`${engine}: no preference`);
      else if (b.pref.engine !== agent || !(b.task.sessions || [b.task.session]).includes(b.pref.session)) bad.push(`${engine}: preference said by ${b.pref.engine} in ${b.pref.session}`);
    }
  }
  if (evidence.codexAsked) bad.push('codex: asked for an approval');
  if (evidence.codex && !evidence.codexRemembered) bad.push('codex: no Remembered line');
  if (evidence.opencode && !evidence.opencodeRemembered) bad.push('opencode: no Remembered line');
  if (bad.length) throw new Error(bad.join('; '));
}
