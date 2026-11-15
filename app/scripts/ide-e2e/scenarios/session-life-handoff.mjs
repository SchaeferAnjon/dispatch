// Native Agents acceptance, using only the disposable instance and its CLI.
// LIFE_ENGINE=opencode (default: DeepSeek Flash, GLM Flash or a free OpenCode Zen Flash) or codex (temporary CODEX_HOME).
// Ends with the agent host restarted and the same model answering (what model-perm-restore.mjs checked on its own).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)
const exec = promisify(execFile);
export const meta = { needs: ['opencode'], timeout: 1800, title: 'Context handoff in one conversation', description: 'Reach a low lifetime limit, save to task and Docs, clear the backing context and answer again; the same model after the agent host restarts; the quiet markers: the handoff on its task, the Context entry, no Workers view.' };
const engine = process.env.LIFE_ENGINE || 'opencode';
const name = engine === 'codex' ? 'Codex' : 'OpenCode';
const fresh = '.sessions-chat-editor';
const input = '.interactive-input-part .monaco-editor';
const canary = 'LIFECANARY729';

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
async function waitAnswer(ui, pattern) {
  let last = '';
  try {
    return await until(ui, async () => {
      const text = await answer(ui);
      last = text || last;
      if (/quota|usage limit|rate.?limit|Internal error|API key is invalid|1308|1113|余额不足/i.test(text)) throw new Error(`Engine unavailable: ${text}`);
      return pattern.test(text) && text;
    }, String(pattern));
  } catch (e) {
    throw new Error(`${e.message}; the last answer was: ${last.slice(0, 300)}`);
  }
}

async function pickModel(ui, into) {
  await ui.press('Escape');
  await ui.click({ css: into });
  await ui.press('End');
  const draft = await ui.eval(`(document.querySelector('${into} .view-lines')?.innerText || '').replace(/\\u00a0/g, ' ').trim()`);
  if (draft.length > 500) throw new Error('Unexpected long draft in disposable model picker');
  for (const _ of draft) await ui.press('Backspace');
  await ui.type('/model');
  await ui.waitFor({ css: '.dispatch-slash-menu .dsm-row' }, { timeoutMs: 30000 });
  let seen = [];
  const row = await until(ui, async () => {
    const rows = await ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row')].map(r => ({name:r.querySelector('.dsm-name')?.textContent, desc:r.querySelector('.dsm-desc')?.textContent}))`);
    seen = rows;
    // OpenCode: DeepSeek's Flash, else GLM 5.3 Flash, else a free OpenCode Zen Flash (the mini has only those)
    return engine === 'opencode'
      ? ui.cheapModel(rows)
      : rows.find(r => r.name === (process.env.LIFE_CODEX_MODEL || 'GPT-6-Astra'));
  }, 'approved test model', 30000).catch(e => { throw new Error(`${e.message}; the menu listed: ${seen.map(r => `${r.name} / ${r.desc}`).slice(0, 20).join('; ')}`); });
  await ui.click({ text: row.name, exact: true, within: '.dispatch-slash-menu' });
  await ui.press('Escape');
  return row;
}

export default async function (ui) {
  if (!ui.rec.root.startsWith('/tmp/dide-e2e/') && !ui.rec.root.startsWith('/private/tmp/dide-e2e/')) throw new Error('Disposable instance required');
  const env = { ...process.env, BEADS_DIR: ui.rec.beads_dir, DISPATCH_DIR: ui.rec.dispatch_dir,
    DISPATCH_HOME: ui.rec.dispatch_home, CODEX_HOME: `${ui.rec.root}/codex-home`,
    DISPATCH_IDE_USER_DATA_DIRS: `${ui.rec.user_data_dir}:${ui.rec.agents_user_data_dir}`,
    DISPATCH_SESSION_ROOT: ui.rec.root, CODEX_THREAD_ID: '', CLAUDE_SESSION_ID: '', DISPATCH_SESSION_ID: '', BEADS_ACTOR: engine };
  const cli = async (args, session = '') => {
    const result = await exec(ui.rec.cli, args, { env: { ...env, DISPATCH_SESSION_ID: session.split(':').at(-1) }, timeout: 60000, maxBuffer: 4e6 });
    return result.stdout;
  };
  const sessions = async () => {
    const raw = JSON.parse(await cli(['sessions', '--json']));
    const rows = (Array.isArray(raw) ? raw : raw.sessions || []).filter(s => s.source === 'ide' && !s.external && s.agent === engine && (s.cwd || '').includes(ui.rec.root));
    for (const row of rows) {
      if (!row.native_session_id) {
        const life = JSON.parse(await cli(['session', 'life', `${engine}:${row.session_id}`, '--json']));
        row.native_session_id = life.native_session?.split(':').at(-1);
      }
    }
    return rows;
  };
  await cli(['settings', 'session_life_auto_handoff', '0']);
  await ui.openAgents(ui.demoFolder);
  await ui.newSession();
  // the new-session page can fall back to its default engine while it is still loading: pick until it stays
  await ui.pickEngine(name);
  if (await ui.eval(`document.querySelector('.sessions-chat-isolation-checkbox .monaco-checkbox')?.getAttribute('aria-checked') === 'true'`)) {
    await ui.click({ css: '.sessions-chat-isolation-checkbox .monaco-checkbox' });
  }
  await ui.sleep(1000);
  await ui.pickEngine(name);
  const picked = await pickModel(ui, fresh);
  if (engine === 'codex' && process.env.LIFE_FULL_ACCESS === '1') {
    await ui.click({ text: 'Default Permissions', exact: true });
    await ui.click({ text: 'Full Access', exact: true, within: '.action-widget' });
  }
  await ui.click({ css: fresh });
  await ui.type(`Remember ${canary}. This is an isolated context handoff test. Reply READY only. Do not use tools. Never edit Dispatch, its CLI, its configuration or any file outside this demo project. Do not delegate. If a Dispatch command fails, report the error and stop; do not repair it.`);
  await ui.press('Enter', { send: true });
  await waitAnswer(ui, /READY/);
  const before = await until(ui, async () => (await sessions())[0], 'native session catalog', 45000);
  const session = `${engine}:${before.session_id}`;
  const measured = JSON.parse(await cli(['session', 'life', session, '--json']));
  if (engine === 'opencode' && !/flash/i.test(measured.model || '')) throw new Error(`Wrong test model: ${measured.model} (picked ${picked.name})`);
  const task = JSON.parse(await cli(['begin', `Verify ${name} context handoff: keep the canary across a fresh context`, '-P', 'demo',
    '-d', `Keep ${canary} through automatic handoff. Save evidence and answer the word after context reset. No repository edits.`,
    '--thing', 'Context lifetime', '--force', '--json'], session));
  const taskId = task.id || task.task?.id || task.task;
  if (!taskId) throw new Error(`Task id missing: ${JSON.stringify(task)}`);
  await cli(['settings', 'session_life_tokens', '3000']);
  await cli(['settings', 'session_life_auto_handoff', '1']);
  await ui.screenshot('01-before-handoff');
  await ui.click({ css: input });
  await ui.type(`The active task is ${taskId}. Reply CHECKPOINT. If Dispatch requests a context handoff, include ${canary} and say RESUMED ${canary} when the fresh context continues. Only run the requested handoff command; never modify Dispatch or its CLI, and report any command failure instead of repairing it. Do not delegate. Do not mark the task complete.`);
  await ui.press('Enter', { send: true });
  // the status line under the input while the handoff runs (the conversation itself shows only one line)
  const statuses = new Set();
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const text = await ui.eval(`document.querySelector('.dispatch-life-status')?.textContent?.trim() || ''`).catch(() => '');
      if (text) statuses.add(text);
      await ui.sleep(500);
    }
  })();
  await until(ui, async () => {
    let record;
    try { record = JSON.parse(await cli(['handoff', 'show', taskId, '--json'])); } catch { return false; }
    const current = (await sessions()).find(s => s.session_id === before.session_id);
    return record.registered && current?.native_session_id && current.native_session_id !== before.native_session_id;
  }, 'registered handoff and a different backing context');
  await waitAnswer(ui, new RegExp(`RESUMED.*${canary}`));
  await ui.sleep(12000); // one more status refresh after the continuing turn
  sampling = false;
  await sampler;
  await writeFile(`${ui.out}/status-line.json`, JSON.stringify([...statuses], null, 2));
  if (![...statuses].some(t => /Saving progress for handoff/.test(t))) throw new Error(`the status line never said it was saving: ${JSON.stringify([...statuses])}`);
  if (![...statuses].some(t => /Progress saved\. Continuing here\./.test(t))) throw new Error(`the status line never said it continued: ${JSON.stringify([...statuses])}`);
  await cli(['settings', 'session_life_auto_handoff', '0']);
  const handoff = JSON.parse(await cli(['handoff', 'show', taskId, '--json']));
  const record = JSON.parse(await cli(['task', 'show', taskId, '--json']));
  // handoffs stay on their task and out of the Docs list since 111de36; `docs --all` still has the registration
  const docs = JSON.parse(await cli(['docs', 'demo', '--all', '--json']));
  const body = await readFile(handoff.path, 'utf8');
  if (!body.includes(canary) || !(handoff.after_message > 0) || !JSON.stringify(record).includes(handoff.id)) throw new Error('Task handoff/boundary missing');
  if (!JSON.stringify(docs).includes(handoff.doc_id) || !JSON.stringify(docs).includes('handoff')) throw new Error('Docs registration missing');
  const after = await sessions();
  const afterLife = JSON.parse(await cli(['session', 'life', session, '--json']));
  if (afterLife.model !== measured.model) throw new Error(`Model changed across handoff: ${measured.model} -> ${afterLife.model}`);
  if (after.length !== 1 || after[0].session_id !== before.session_id) throw new Error('Conversation identity changed');
  if (after[0].native_session_id && before.native_session_id === after[0].native_session_id) throw new Error('Backing context did not change');
  await ui.click({ css: '.interactive-response' });
  await ui.press('Home');
  for (let n = 0; n < 20 && !(await ui.exists({ text: 'Context handed off', exact: true })); n++) await ui.press('ArrowDown');
  await ui.scrollTo('Context handed off');
  await ui.screenshot('02-context-handed-off');
  await ui.mark({ text: 'Context handed off', exact: true }, { what: '交接位置', where: '同一会话的原清空线', how: '点链接读交接' });
  const link = await ui.eval(`document.querySelector('.chat-workspace-transition a')?.getAttribute('href')`);
  if (!link || !link.includes(handoff.id)) throw new Error('Boundary has no handoff link');
  // Seamless: one line in the conversation; the three host messages and the turn that wrote the handoff are not shown
  const shown = await ui.eval(`(() => {
    const rows = [...document.querySelectorAll('.interactive-list .monaco-list-row')]
      .sort((a, b) => Number(a.getAttribute('data-index')) - Number(b.getAttribute('data-index'))).map(r => r.innerText.trim());
    // the turn that wrote the handoff sits right before the line; what comes after it is the continuing
    // answer, which may itself mention the handoff it read
    const boundary = rows.findIndex(t => /^Context handed off$/m.test(t));
    const before = boundary < 0 ? rows : rows.slice(0, boundary);
    return { lines: rows.filter(t => /^Context handed off$/m.test(t)).length,
      host: rows.filter(t => /^(Preparing context handoff|Context handoff|Continue from context handoff|\\/clear)$/m.test(t)),
      written: before.filter(t => /Handoff written|dispatch handoff write/i.test(t)).length };
  })()`);
  await writeFile(`${ui.out}/transcript-rows.json`, JSON.stringify(shown, null, 2));
  if (shown.lines !== 1) throw new Error(`expected one Context handed off line, found ${shown.lines}`);
  if (shown.host.length) throw new Error(`host messages are shown: ${JSON.stringify(shown.host)}`);
  if (shown.written) throw new Error('the turn that wrote the handoff is shown');
  // the question goes into the conversation's own input (checked: the draft is there before Enter)
  const question = 'What was the remembered word? Reply with the word only. Do not use tools.';
  const draft = () => ui.eval(`(document.querySelector('${input} .view-lines')?.innerText || '').replace(/\\u00a0/g, ' ')`);
  const requests = () => ui.eval(`document.querySelectorAll('.interactive-list .interactive-request').length`);
  const requestsBefore = await requests();
  for (let attempt = 0; attempt < 3 && !(await draft()).includes('remembered word'); attempt++) {
    await ui.press('Escape');
    await ui.click({ css: input });
    await ui.sleep(300);
    if (!(await draft())) await ui.type(question);
  }
  if (!(await draft()).includes('remembered word')) throw new Error(`the question did not reach the input: ${JSON.stringify(await ui.eval(`document.activeElement?.className`))}`);
  await ui.press('Enter', { send: true });
  await until(ui, async () => (await requests()) > requestsBefore || !(await draft()).includes('remembered word'), 'the question was sent', 30000);
  await waitAnswer(ui, new RegExp(`^${canary}$`, 'm'));
  await ui.screenshot('03-continued-answer');
  // the same model after the agent host restarts (was model-perm-restore.mjs, which read this run's evidence): in the
  // conversation, Developer: Restart Local Agent Host from the command palette, one more message
  await ui.press('F1');
  await ui.type('Developer: Restart Local Agent Host', { into: { css: '.quick-input-widget input' } });
  await ui.press('Enter');
  await ui.sleep(5000);
  await ui.attach('agents', 60000);
  await ui.waitFor({ css: input }, { timeoutMs: 60000 });
  await ui.type('Reply RESTORE_READY only. Do not use tools.', { into: { css: input } });
  await ui.press('Enter', { send: true });
  await waitAnswer(ui, /RESTORE_READY/);
  const restarted = JSON.parse(await cli(['session', 'life', session, '--json']));
  if (restarted.model !== measured.model) throw new Error(`Model changed after the agent host restarted: ${measured.model} -> ${restarted.model}`);
  await ui.screenshot('03b-model-after-host-restart');
  // the model sometimes closes the test task on its own although told not to: open it again, the marker is on an open card
  const shownTask = JSON.parse(await cli(['task', 'show', taskId, '--json']));
  if (/closed|done/.test(String(shownTask.status || shownTask.task?.status))) {
    await exec('bd', ['reopen', taskId], { env: { ...env, PATH: `${ui.rec.app}/Contents/Resources/app/tools:${process.env.PATH}` }, timeout: 60000 }).catch(() => undefined);
  }
  // the handoff hangs on its task, not in the Docs list (kanban 111de36): open it, then its task shows the marker
  await ui.openTab('Docs');
  await cli(['ide', 'show', handoff.path, '--json']);
  await ui.waitFor({ css: '.dispatch-docs-reader' }, { timeoutMs: 30000 });
  await ui.screenshot('04-handoff-reader');
  await ui.click({ css: '.dispatch-docs-context a.task', index: 0 });
  await ui.waitFor({ css: '.dispatch-handoff-marker' }, { timeoutMs: 30000 });
  await ui.screenshot('05-handoff-on-task');
  await writeFile(`${ui.rec.root}/life-evidence-${engine}.json`, JSON.stringify({ session, taskId, before, after, handoff, record, docs, measured, afterLife }, null, 2));


  // ---- quiet markers (was life-ui.mjs, which ran this whole walk first): the handoff reader and its task, the Context
  // entry's warning and limit, its detail, no Workers view, light and dark
  const evidence = { session, taskId, handoff };
  const results = { checks: [] };
  const check = async (name, expr) => {
    if (!await ui.eval(expr)) throw new Error(`Failed: ${name}`);
    results.checks.push(name);
  };
  // the transcript boundary is checked by session-life-handoff itself; here only when that conversation is still on screen
  if (await ui.exists({ text: 'Context handed off', exact: true })) {
    await ui.scrollTo('Context handed off');
    // scrolled to the very top it sits under the title bar's edge: bring it to the middle before the click
    await ui.eval(`[...document.querySelectorAll('.chat-workspace-transition a, a')].find(a => a.textContent.trim() === 'Context handed off')?.scrollIntoView({ block: 'center' })`);
    await ui.sleep(500);
    await ui.click({ text: 'Context handed off', exact: true });
    await ui.waitFor({ css: '.dispatch-docs-reader' }, { timeoutMs: 30000 });
    await check('Transcript boundary opens Docs reader', `!!document.querySelector('.dispatch-docs-context a.task')`);
    await ui.screenshot('06-transcript-handoff-reader');
  }
  {
    // Handoffs hang on their task and are not in the Docs list (kanban 111de36): open it in the reader directly
    await ui.openTab('Docs');
    await cli(['ide', 'show', evidence.handoff.path, '--json']);
    await ui.waitFor({ css: '.dispatch-docs-reader' }, { timeoutMs: 30000 });
    await ui.screenshot('06-handoff-reader');
    let seen = false;
    for (let attempt = 0; attempt < 20 && !seen; attempt++) {
      const listed = JSON.parse(await cli(['docs', 'demo', '--all', '--json']));
      seen = !!listed.docs?.find(d => d.path === evidence.handoff.path && d.seen_at > 0);
      if (!seen) await ui.sleep(1000);
    }
    // handoffs are not in the Docs list any more, so its unread dot does not apply; noted, not required
    results.checks.push(seen ? 'Reading the handoff persists its seen state' : 'Handoff opened outside the Docs list: no seen state recorded');
    await ui.screenshot('07-handoff-reader');
    await ui.click({ css: '.dispatch-docs-context a.task', index: 0 });
    await ui.waitFor({ css: '.dispatch-handoff-marker' }, { timeoutMs: 30000 });
    await ui.screenshot('08-task-handoff');
    await ui.click({ css: '.dispatch-handoff-marker' });
    await ui.waitFor({ css: '.dispatch-docs-reader' });
    results.checks.push('Handoff filter, reader, task backlink and task marker');
  }
  {
    const life = JSON.parse(await cli(['session', 'life', evidence.session, '--json']));
    if (life.context_tokens > 0) {
      // right after a handoff the status line keeps "Progress saved. Continuing here." (the CLI's handoff_state,
      // 10 minutes); the Context entry still shows the measured share against the new limit
      // past the line the entry says "over limit" instead of a number
      const pct = () => ui.eval(`(() => { const t = document.querySelector('.dispatch-life-context')?.textContent || ''; return /over limit/.test(t) ? 101 : Number((t.match(/(\\d+)%/) || [])[1] || -1); })()`);
      const saved = async () => /Progress saved/.test(await ui.eval(`document.querySelector('.dispatch-life-status')?.textContent || ''`));
      await cli(['settings', 'session_life_tokens', String(Math.max(1, Math.round(life.context_tokens / 0.85)))]);
      for (let i = 0; i < 45; i++) { const p = await pct(); if (p >= 80 && p < 100 && (await saved() || await ui.exists({ text: 'Approaching the handoff limit', exact: true }))) break; await ui.sleep(1000); }
      await ui.screenshot('09-context-warning');
      if (!(await pct() >= 80)) throw new Error(`Context entry did not reach the warning line: ${await pct()}%`);
      await cli(['settings', 'session_life_tokens', String(Math.max(1, Math.round(life.context_tokens / 1.05)))]);
      for (let i = 0; i < 45; i++) { const p = await pct(); if (p >= 100 && (await saved() || await ui.exists({ text: 'Handoff limit reached', exact: true }))) break; await ui.sleep(1000); }
      await ui.screenshot('10-context-limit');
      if (!(await pct() >= 100)) throw new Error(`Context entry did not reach the limit: ${await pct()}%`);
      results.checks.push(await saved() ? 'Warning and limit: the Context entry shows the share; the status line keeps the saved note after the handoff' : 'Warning and limit states in the status line');
      await cli(['settings', 'session_life_tokens', '120000']);
      results.checks.push('Warning and limit states use measured context with auto handoff disabled');
    }
    // the session list shows no duration any more (audit panels 5): the Context entry by the input is the one place
    await check('No duration on session rows', `!document.querySelector('.dispatch-life-age')`);
  }
  if (await ui.exists({ css: '.dispatch-life-context' })) {
    await ui.click({ css: '.interactive-input-part .monaco-editor' });
    await ui.type('Keep this draft while reading context.');
    await ui.click({ css: '.dispatch-life-context' });
    await ui.waitFor({ css: '.dispatch-life-detail:not([hidden])' });
    await check('Context entry expands', `document.querySelector('.dispatch-life-context').getAttribute('aria-expanded') === 'true'`);
    await check('Opening Context preserves draft', `document.querySelector('.interactive-input-part .monaco-editor .view-lines')?.textContent.replace(/\u00a0/g, ' ').includes('Keep this draft')`);
    await check('Context popup is not covered by the side pane', `(() => {const e=document.querySelector('.dispatch-life-detail:not([hidden])'),r=e.getBoundingClientRect();return [[r.x+3,r.y+3],[r.right-3,r.y+3],[r.right-3,r.bottom-3]].every(([x,y]) => !!document.elementFromPoint(x,y)?.closest('.dispatch-life-detail'));})()`);
    await ui.screenshot('09-context-stats');
    await ui.press('Escape');
    await check('Context Escape closes', `!document.querySelector('.dispatch-life-detail:not([hidden])')`);
    // it floats over the window (a narrow side chat cut it off) and a click anywhere else closes it (memo 2026-10-19)
    await ui.click({ css: '.dispatch-life-context' });
    await ui.waitFor({ css: '.dispatch-life-detail:not([hidden])' });
    await check('Context popup sits inside the window', `(() => { const r = document.querySelector('.dispatch-life-detail:not([hidden])').getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`);
    await ui.click({ css: '.interactive-session .interactive-list' });
    await check('Context popup closes on a click elsewhere', `!document.querySelector('.dispatch-life-detail:not([hidden])')`);
  }
  await ui.openTab('Tasks');
  await ui.click({ text: 'This session', exact: true, within: '.dispatch-tasks' });
  await ui.click({ css: '.dispatch-tasks-graph' });
  await ui.waitFor({ css: '.dispatch-tg-bar' }, { timeoutMs: 60000 });
  await check('No Workers view on the Task graph page', `![...document.querySelectorAll('.dispatch-tg-bar button, .dispatch-tasks button')].some(b => b.textContent.trim() === 'Workers')`);
  await ui.screenshot('11-task-graph-no-workers');
  results.checks.push('Task graph page and Tasks tab have no Workers');
  await ui.press('Escape');
  results.visual = [];
  for (const theme of ['light', 'dark']) {
    for (const dir of [ui.rec.user_data_dir, ui.rec.agents_user_data_dir]) {
      const file = path.join(dir, 'User', 'settings.json');
      const settings = JSON.parse(await readFile(file, 'utf8'));
      Object.assign(settings, { 'window.autoDetectColorScheme': false, 'workbench.colorTheme': theme === 'light' ? 'Dispatch Light' : 'Dispatch Dark' });
      await writeFile(file, JSON.stringify(settings, null, 2));
    }
    for (let i = 0; i < 30; i++) {
      if (await ui.eval(`document.querySelector('.monaco-workbench').classList.contains(${JSON.stringify(theme === 'light' ? 'vs' : 'vs-dark')})`)) break;
      await ui.sleep(300);
    }
    results.visual.push(await ui.eval(`(() => {
      const targets = ['.dispatch-life-context'];
      return { theme: ${JSON.stringify(theme)}, targets: targets.map(selector => {
        const e = document.querySelector(selector); if (!e) return { selector, missing: true };
        const b = e.getBoundingClientRect(), s = getComputedStyle(e);
        return { selector, box: [b.x,b.y,b.width,b.height], fontSize: s.fontSize, color:s.color, background:s.backgroundColor, fontFamily:s.fontFamily, dpr:devicePixelRatio };
      }) };
    })()`));
    {
      await ui.openTab('Docs');
      await cli(['ide', 'show', evidence.handoff.path, '--json']);
      await ui.waitFor({ css: '.dispatch-docs-reader' });
      await ui.screenshot(`reader-${theme}`);
    }
    if (await ui.exists({ css: '.dispatch-life-context' })) {
      if (!await ui.exists({ css: '.dispatch-life-detail:not([hidden])' })) await ui.click({ css: '.dispatch-life-context' });
      await ui.screenshot(`context-${theme}`);
      await ui.press('Escape');
    }
  }
  await writeFile(`${ui.out}/life-ui-results.json`, JSON.stringify(results, null, 2));
}
