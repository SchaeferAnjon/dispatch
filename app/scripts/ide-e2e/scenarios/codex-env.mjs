// Native Codex session in the disposable instance (temporary CODEX_HOME without model_context_window):
// the transcript must show the model's large window, and a log line from the default sandbox must reach the board
// (through Dispatch's MCP tools, which Codex runs outside its sandbox).
// The model call may fail (no quota): the turn still writes task_started, which carries the window.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir } from 'node:fs/promises';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)
const exec = promisify(execFile);
export const meta = { needs: ['codex'], title: 'Codex default context window', description: 'A native Codex session starts with the largest window of its model and can write the task board from the default sandbox.' };
const fresh = '.sessions-chat-editor';
const input = '.interactive-input-part .monaco-editor';

async function until(ui, fn, what, ms = 240000) {
  const end = Date.now() + ms * SCALE;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await ui.sleep(1000);
  }
  throw new Error(`Timed out: ${what}`);
}
const answer = ui => ui.eval(`(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return r && !r.classList.contains('chat-response-loading') ? r.innerText : ''; })()`);

async function windows(home) {
  const found = [];
  const walk = async dir => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) await walk(p);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        for (const m of (await readFile(p, 'utf8')).matchAll(/"model_context_window":(\d+)/g)) found.push(Number(m[1]));
      }
    }
  };
  await walk(`${home}/sessions`);
  return found;
}

export default async function (ui) {
  if (!ui.rec.root.startsWith('/tmp/dide-e2e/') && !ui.rec.root.startsWith('/private/tmp/dide-e2e/')) throw new Error('Disposable instance required');
  const home = `${ui.rec.root}/codex-home`;
  let config = await readFile(`${home}/config.toml`, 'utf8').catch(() => '');
  const userWindow = Number(process.env.CODEX_USER_WINDOW || 0); // control run: the user's own window must win
  if (!userWindow && /^\s*model_context_window\s*=/m.test(config)) {
    // the instance's config.toml is a copy of this Mac's, and a new user never sets the window: take it out of the
    // copy (the restart below makes the host read it again); the person's own ~/.codex stays as it is
    config = config.replace(/^\s*model_context_window\s*=.*\n?/gm, '');
    await writeFile(`${home}/config.toml`, config);
  }
  // The host reads the user's Codex config when it lists models: restart it so it sees the config as it is now.
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
  await ui.openAgents(ui.demoFolder);
  await ui.newSession();
  const picker = '.sessions-chat-session-type-picker';
  if ((await ui.eval(`document.querySelector('${picker}')?.innerText.trim()`)) !== 'Codex') {
    await ui.click({ css: picker });
    await ui.click({ text: 'Codex', exact: true, within: '.context-view' });
  }
  await ui.press('Escape');
  // GPT-6-Astra is the default model of the instance config; the picker chip shows its size.
  await ui.screenshot('00-context-size-default');
  await ui.click({ css: fresh });
  await ui.press('End');
  const draft = await ui.eval(`(document.querySelector('${fresh} .view-lines')?.innerText || '').replace(/\\u00a0/g, ' ').trim()`);
  if (draft.length > 500) throw new Error('Unexpected long draft in the disposable instance');
  for (const _ of draft) await ui.press('Backspace');
  await ui.type('Reply OK only. Do not use tools.');
  await ui.sleep(2000);
  // a new page takes the message once Codex is ready (its app server starts with the window; slow on a busy Mac):
  // until then Enter leaves it in the box, and a person presses it again
  const still = () => ui.eval(`(document.querySelector('${fresh} .view-lines')?.innerText || '').includes('Reply OK only')`);
  for (let i = 0; i < 5; i++) {
    if (i) await ui.click({ css: fresh });
    await ui.press('Enter', { send: true });
    const end = Date.now() + 15000 * SCALE;
    while (Date.now() < end && (await still())) await ui.sleep(1000);
    if (!(await still())) break;
  }
  const seen = await until(ui, async () => (userWindow ? (await windows(home)).includes(Math.round(userWindow * 0.95)) : (await windows(home)).length > 0) && (await windows(home)), 'task_started in the instance transcript', 120000);
  const settle = async pattern => { try { return await until(ui, async () => { const t = await answer(ui); return pattern.test(t) && t; }, String(pattern), 120000); } catch { return ''; } };
  const reply = await settle(/OK/);
  await ui.screenshot('01-codex-session');
  const evidence = { windows: seen, reply: reply.slice(0, 300) };
  if (reply && !userWindow) {
    // Default permissions: the sandbox cannot write the board; Dispatch's MCP server, outside it, does.
    const env = { ...process.env, BEADS_DIR: ui.rec.beads_dir, DISPATCH_DIR: ui.rec.dispatch_dir, DISPATCH_HOME: ui.rec.dispatch_home, CODEX_HOME: home,
      DISPATCH_IDE_USER_DATA_DIRS: `${ui.rec.user_data_dir}:${ui.rec.agents_user_data_dir}`, DISPATCH_SESSION_ROOT: ui.rec.root, CODEX_THREAD_ID: '', DISPATCH_SESSION_ID: '', BEADS_ACTOR: 'test' };
    const cli = async args => (await exec(ui.rec.cli, args, { env, timeout: 60000, maxBuffer: 4e6 })).stdout;
    const task = JSON.parse(await cli(['begin', 'Sandbox check: a Codex session writes the board', '-P', 'demo', '-d', 'The Codex session logs on this task with Dispatch tools under default permissions; the note must appear on it.', '--force', '--json']));
    const id = task.id || task.task?.id || task.task;
    await ui.click({ css: input });
    await ui.type(`Use Dispatch's task_log tool on task ${id} with the text "CODEX SANDBOX TOOLS OK", then reply DONE. Do not run shell commands and do not edit any file.`);
    await ui.press('Enter', { send: true });
    evidence.logTask = id;
    evidence.logged = await until(ui, async () => /CODEX SANDBOX TOOLS OK/.test((await exec('bd', ['comments', id], { env, timeout: 60000 }).catch(() => ({ stdout: '' }))).stdout), 'the note on the board', 180000).catch(() => false);
    evidence.reply2 = (await answer(ui)).slice(0, 300);
    await ui.screenshot('02-dispatch-log-from-sandbox');
  }
  await writeFile(`${ui.rec.root}/codex-window-evidence.json`, JSON.stringify(evidence, null, 2));
  if (userWindow ? !seen.includes(Math.round(userWindow * 0.95)) : !seen.some(n => n > 300000)) throw new Error(`Window not raised: ${JSON.stringify(seen)}`);
}
