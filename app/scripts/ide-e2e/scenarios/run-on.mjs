// Run on (kanban task-qb6j; Dispatch IDE patches/280-run-on.patch, dispatch-bridge `dispatch.machines runOn`):
// the way a person starts a session on their other Mac. The instance knows one other Mac, as if it had been added
// in Settings › Macs (DISPATCH_E2E_RUN_ON="user@address name", default the instance's own second Mac, fixtures/other_mac.py). The new session page says
// "This Mac"; its menu lists This Mac, the other Mac and Add another Mac...; picking the other Mac copies Dispatch's
// server there when needed, connects, and asks for a folder there; the folder chip then names that Mac, a message
// goes out with a cheap model and the reply comes back; on that Mac OpenCode has the session in that folder; in
// the sessions list the row carries the machine tag; This Mac brings the page back to a folder here.
// Only a free or flash model is ever used.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)

// a real second Mac (DISPATCH_E2E_RUN_ON): the instance's own stand-in (fixtures/other_mac.py, this Mac again) shares this
// Mac's OpenCode, whose store the session then went into (the person's own), so it does not stand in here
export const meta = { needs: ['opencode', 'app-bundle', 'env:DISPATCH_E2E_RUN_ON'],
  setup: 'DISPATCH_E2E_RUN_ON="user@address name" names a second Mac this one reaches over ssh with its own key (the mini: "apple@100.64.0.11 mini"); run on the packaged app',
  title: '新建会话时选在哪台电脑上跑',
  description: '新建会话页第一个胶囊是 This Mac；点开选 mini，连上后选 mini 上的文件夹，用便宜模型发一句，回复回来；左栏这条会话带 mini 的机器标；再选 This Mac 回到本机文件夹。',
};

function assert(ok, message) { if (!ok) throw new Error(message); }

// the second Mac: the instance's own (fixtures/other_mac.py, this Mac again over ssh as a person of its own), or one named
const [TARGET, NAME] = (process.env.DISPATCH_E2E_RUN_ON || `${process.env.DISPATCH_E2E_OTHER_MAC || 'apple@100.64.0.11'} mini`).split(/\s+/);
const FOLDER = 'dispatch-runon-demo';
const CHIP = '.dispatch-run-on .action-label';

function ssh(cmd, timeout = 60000) {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', TARGET, cmd], { encoding: 'utf8', timeout });
  if (r.status !== 0) throw new Error(`ssh ${TARGET}: ${(r.stderr || r.stdout || '').trim()}`);
  return r.stdout.trim();
}

const chipText = (ui) => ui.eval(`document.querySelector('${CHIP}')?.innerText.trim() || ''`);
const pickerRow = (ui) => ui.eval("document.querySelector('.new-session-workspace-picker-container')?.innerText.replace(/\\s+/g, ' ').trim() || ''");

/** First-run tips sit beside the side bar, over the new session page's chips: out of the way, as a person would close them. */
async function closeTips(ui) {
  for (let i = 0; i < 6 && await ui.exists({ css: '.dispatch-tour-close' }); i++) { await ui.click({ css: '.dispatch-tour-close' }); await ui.sleep(400); }
}

/** A new session page on this Mac: a new session keeps the Mac the last one ran on, so pick This Mac when it is not. */
async function backToThisMac(ui) {
  await ui.newSession();
  await ui.sleep(1500);
  const chip = await chipText(ui);
  if (chip !== 'This Mac') {
    await closeTips(ui);
    await ui.click({ css: CHIP });
    await ui.waitFor({ text: 'This Mac', exact: true, within: '.context-view' }, { timeoutMs: 15000 });
    await ui.click({ text: 'This Mac', exact: true, within: '.context-view' });
    await waitFor(ui, 'back on this Mac', async () => (await chipText(ui)) === 'This Mac', 30000);
  }
  return chip;
}

async function waitFor(ui, what, fn, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`${what}: not after ${timeoutMs / 1000} s`);
    await ui.sleep(500);
  }
}

// ---- the cheap model, picked the way a person does it: /model in the input box (as notify-sleep.mjs) ----
async function untilFn(ui, fn, timeoutMs, what, every = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs * SCALE) { const v = await fn(); if (v) return v; await ui.sleep(every); }
  throw new Error(`timed out waiting for ${what}`);
}
const MENU = ".dispatch-slash-menu";
const inputText = (ui, input) => ui.eval(`(document.querySelector('${input} .view-lines')?.innerText || '').replace(/\\u00a0/g, ' ').trim()`);
const readMenu = (ui) => ui.eval(`(() => {
  const m = document.querySelector('${MENU}');
  if (!m) return null;
  const heads = [...m.querySelectorAll('.dsm-head')].map(h => ({ name: h.querySelector('.dsm-head-name')?.textContent }));
  const rows = [...m.querySelectorAll('.dsm-row')].map(r => ({ name: r.querySelector('.dsm-name')?.textContent, desc: r.querySelector('.dsm-desc')?.textContent || '', selected: r.classList.contains('selected') }));
  return { heads, rows };
})()`);
const waitMenu = (ui, check, what, timeoutMs = 15000) => untilFn(ui, async () => { const m = await readMenu(ui); return m && !(await ui.exists({ css: `${MENU} .dsm-loading` })) && check(m) ? m : null; }, timeoutMs, `menu: ${what}`, 300);
/** The input box has the keyboard focus (a click right after a menu closes can land before the box is back). */
async function focusInput(ui, input) {
  const has = () => ui.eval(`!!document.activeElement?.closest('${input}')`);
  for (let i = 0; i < 6 && !(await has()); i++) {
    await ui.click({ css: `${input} .monaco-editor .view-lines` });
    await ui.sleep(500);
    if (!(await has())) await ui.eval(`document.querySelector('${input} .native-edit-context, ${input} textarea')?.focus()`);
  }
  if (!(await has())) throw new Error("the input box does not take the keyboard focus");
}
async function clearInput(ui, input) {
  await focusInput(ui, input);
  await ui.press("End");
  for (let i = 0; i < 200 && (await inputText(ui, input)).length; i++) await ui.press("Backspace");
}
/** GLM-5.3 Flash or DeepSeek's flash model (CLAUDE.md: cheap models only, never Claude), else a free OpenCode Zen one. */
async function chooseCheapModel(ui, input) {
  await clearInput(ui, input);
  await ui.type("/model");
  const models = await waitMenu(ui, m => m.heads.length === 1 && m.heads[0].name === "Model", "Model group", 30000);
  const row = ui.cheapModel(models.rows);
  if (!row) throw new Error(`no cheap test model (listed: ${models.rows.map(r => r.name + " / " + r.desc).slice(0, 30).join("; ")})`);
  await clearInput(ui, input);
  await ui.type(`/${row.name.replace(/\s+/g, "")}`);
  let choices = await waitMenu(ui, m => m.rows.some(r => r.name === row.name && r.desc === row.desc), row.name);
  for (let n = 0; n < choices.rows.length + 2 && !choices.rows.some(r => r.selected && r.name === row.name && r.desc === row.desc); n++) {
    await ui.press("ArrowDown");
    choices = await readMenu(ui);
  }
  await ui.press("Enter", { send: true });
  await ui.sleep(1500);
  await clearInput(ui, input);
  await ui.press("Escape");
  return row;
}

export default async function (ui) {
  const facts = { target: TARGET, name: NAME };
  const home = ssh('echo $HOME');
  const remoteDir = `${home}/${FOLDER}`;
  ssh(`mkdir -p ${FOLDER} && cd ${FOLDER} && { [ -d .git ] || { git init -q && echo '# Run on demo' > README.md && git add . && git -c user.email=e2e@dispatch -c user.name=e2e commit -qm init; }; }`);
  // the other Mac, as Settings › Macs would have added it
  fs.writeFileSync(path.join(ui.rec.dispatch_dir, 'hosts.json'), JSON.stringify([{ id: NAME, name: NAME, ssh: TARGET }], null, 2));
  // a Mac of that name that did not answer at another address (run-on-offline) is not this one: Settings › Macs
  // forgets the old address's failure when the address changes (host_admin.py), so does this
  fs.rmSync(path.join(ui.rec.dispatch_dir, 'remote', `${NAME}.down`), { force: true });

  await ui.openAgents();
  await ui.sleep(3000);
  // 1. a new session runs on this Mac unless you say otherwise (an instance an earlier run left on the other Mac goes back first)
  await ui.waitFor({ css: CHIP }, { timeoutMs: 30000 });
  facts.leftOn = await backToThisMac(ui);
  facts.chipBefore = await chipText(ui);
  assert(facts.chipBefore === 'This Mac', `the chip says "${facts.chipBefore}"`);
  facts.rowBefore = await pickerRow(ui);
  await ui.screenshot('01-new-session-this-mac');
  await ui.mark({ css: CHIP }, { what: '在哪台电脑上跑', where: '新建会话页，文件夹胶囊左边', how: '默认 This Mac，点开可选别的 Mac' });

  // 2. the menu: this Mac, the other one, add another
  await closeTips(ui);
  await ui.click({ css: CHIP });
  await ui.waitFor({ text: NAME, exact: true, within: '.context-view' }, { timeoutMs: 30000 });
  facts.menu = await waitFor(ui, 'the menu to say the other Mac answers', async () => {
    const rows = await ui.eval("[...document.querySelectorAll('.context-view .monaco-list-row')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())");
    return rows.some(r => r.startsWith(NAME) && r.includes('Online')) ? rows : null;
  }, 30000);
  assert(facts.menu.some(r => r.startsWith('This Mac')) && facts.menu.some(r => r.startsWith('Add another Mac')), `menu: ${facts.menu.join(' | ')}`);
  await ui.screenshot('02-run-on-menu');
  await ui.mark({ text: NAME, exact: true, within: '.context-view' }, { what: '另一台 Mac', where: 'Run on 菜单', how: '点它，会话就在那台电脑上跑' });

  // 3. pick the other Mac: it connects (copying Dispatch over the first time), then asks for a folder there
  const t0 = Date.now();
  await ui.click({ text: NAME, exact: true, within: '.context-view' });
  await ui.sleep(300);
  facts.chipConnecting = await chipText(ui);
  await waitFor(ui, 'the folder question', () => ui.eval("(() => { const t = document.querySelector('.quick-input-widget .quick-input-title'); return t && t.offsetParent ? t.innerText : ''; })()"), 300000);
  facts.connectSeconds = Math.round((Date.now() - t0) / 100) / 10;
  facts.folderQuestion = await ui.eval("document.querySelector('.quick-input-widget .quick-input-title')?.innerText");
  facts.folderChoices = await ui.eval("[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].slice(0, 6).map(r => r.innerText.replace(/\\s+/g, ' ').trim())");
  await ui.screenshot('03-which-folder');
  if (/Which folder/.test(facts.folderQuestion)) {
    await ui.click({ text: `Choose another folder on ${NAME}...`, within: '.quick-input-widget' });
    await waitFor(ui, 'the folder dialog', () => ui.eval("/Select Folder/.test(document.querySelector('.quick-input-widget .quick-input-title')?.innerText || '')"), 60000);
  }
  await ui.eval(`(() => { const i = document.querySelector('.quick-input-widget .quick-input-box input'); i.value = ${JSON.stringify(remoteDir + '/')}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await ui.sleep(2500);
  await ui.click({ text: 'OK', exact: true, within: '.quick-input-widget' });
  await waitFor(ui, 'the folder on the other Mac', async () => (await pickerRow(ui)).includes(`${FOLDER} [${NAME}]`), 30000);
  facts.chipAfter = await chipText(ui);
  facts.rowAfter = await pickerRow(ui);
  assert(facts.chipAfter === NAME, `after connecting the chip says "${facts.chipAfter}"`);
  await ui.screenshot('04-runs-on-other-mac');
  await ui.mark({ css: '.new-session-workspace-picker-container' }, { what: '会话会在 mini 上跑', where: '新建会话页的胶囊', how: 'Run on 写 mini，文件夹是 mini 上的' });

  // 4. a message with a cheap model, the reply comes back from that Mac
  // OpenCode on that Mac (its list can take a while); a first-run tip that turns up over the chips is closed each round
  for (let t0 = Date.now(); ;) {
    await closeTips(ui);
    try { await ui.pickEngine('OpenCode', 20000); break; } catch (e) { if (Date.now() - t0 > 180000) throw e; }
  }
  const model = () => ui.eval("document.querySelector('.model-picker-split')?.innerText.trim() || ''");
  facts.modelFirst = await model();
  if (!/flash|free/i.test(facts.modelFirst)) {
    const cheap = await chooseCheapModel(ui, '.sessions-chat-editor');
    facts.modelPicked = `${cheap.name} (${cheap.desc})`;
  }
  facts.model = await model();
  assert(/flash|free/i.test(facts.model), `refusing to send with ${facts.model}`);
  const newWorktree = { css: '.sessions-chat-isolation-checkbox [role="checkbox"][aria-checked="true"]' };
  if (await ui.exists(newWorktree)) {
    await ui.click({ text: 'Separate copy', exact: true, within: '.sessions-chat-isolation-checkbox' });
    await ui.waitFor(newWorktree, { gone: true, timeoutMs: 10000 });
  }
  await ui.click({ css: '.sessions-chat-editor' });
  await ui.type('Reply with exactly RUN_ON_OK. Do not use any tools.');
  await ui.press('Enter', { send: true });
  await ui.waitFor({ text: 'RUN_ON_OK', within: '.interactive-list .interactive-response' }, { timeoutMs: 240000 });
  await ui.sleep(1500);
  await ui.screenshot('05-reply-from-other-mac');
  await ui.mark({ css: '.interactive-list .interactive-response' }, { what: 'mini 上的回复', where: '对话区', how: `OpenCode（${facts.model}）在 mini 的 ${FOLDER} 里跑` });

  // 5. it really ran there: OpenCode on that Mac has the session, in that folder
  facts.remoteSessions = ssh(`PATH=$HOME/.opencode/bin:$HOME/.bun/bin:/opt/homebrew/bin:$PATH opencode db "select directory, title from session order by time_updated desc limit 3" --format json </dev/null`);
  assert(facts.remoteSessions.includes(remoteDir), `no OpenCode session in ${remoteDir} on ${NAME}: ${facts.remoteSessions.slice(0, 300)}`);

  // 6. the sessions list: the row says which Mac it runs on
  await waitFor(ui, 'the machine tag on the row', () => ui.eval(`[...document.querySelectorAll('.dispatch-run-on-row-tag')].some(t => t.offsetParent && t.innerText.trim() === ${JSON.stringify(NAME)})`), 30000);
  facts.rows = await ui.eval("[...document.querySelectorAll('.dispatch-run-on-row-tag')].filter(t => t.offsetParent).map(t => t.closest('.monaco-list-row')?.innerText.replace(/\\s+/g, ' ').trim().slice(0, 120))");
  await ui.screenshot('06-row-machine-tag');
  await ui.mark({ css: '.dispatch-run-on-row-tag' }, { what: '这条会话在 mini 上跑', where: '左栏会话行末尾', how: '机器标写机器名' });

  // 7. back to this Mac
  facts.chipNewSession = await backToThisMac(ui);
  facts.rowBack = await pickerRow(ui);
  assert(!facts.rowBack.includes(`[${NAME}]`), `still on ${NAME}: ${facts.rowBack}`);
  await ui.screenshot('07-back-on-this-mac');

  // 8. the other Mac once more in the same window: the connection the window has is used, the folder question comes
  await closeTips(ui);
  await ui.click({ css: CHIP });
  await ui.waitFor({ text: NAME, exact: true, within: '.context-view' }, { timeoutMs: 30000 });
  const t1 = Date.now();
  await ui.click({ text: NAME, exact: true, within: '.context-view' });
  facts.againQuestion = await waitFor(ui, 'the folder question the second time', () => ui.eval("(() => { const t = document.querySelector('.quick-input-widget .quick-input-title'); return t && t.offsetParent ? t.innerText : ''; })()"), 60000);
  facts.againSeconds = Math.round((Date.now() - t1) / 100) / 10;
  facts.againNotes = await ui.eval("[...document.querySelectorAll('.notification-toast-container .notification-list-item')].map(e => e.innerText.replace(/\\s+/g, ' ').trim())");
  assert(!facts.againNotes.some(n => /Could not start|did not answer/.test(n)), `picking ${NAME} again: ${facts.againNotes.join(' | ')}`);
  await ui.screenshot('08-again-which-folder');
  await ui.press('Escape');
  fs.writeFileSync(path.join(ui.out, 'facts.json'), JSON.stringify(facts, null, 2));
}
