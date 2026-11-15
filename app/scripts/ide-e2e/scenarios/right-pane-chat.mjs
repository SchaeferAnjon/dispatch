// The side pane of a chat without a folder (Chats) is never a blank block: 0.9.2 showed an empty side pane with only
// a close button on a Chats session that had a delivered task. A chat has no Changes or Files tab, the Now tab joined
// only a strip that already had tabs, so the open pane stayed empty. Now the pane always says something: the Now tab
// (the task, its plan, what it delivered), or an empty state that says why there is nothing and what to do.
// Real messages go to OpenCode's cheap model only (CLAUDE.md), never Claude.
export const meta = {
  needs: ['opencode'],
  title: '无文件夹会话的右栏不空白',
  description: 'Chats 里的会话（没有文件夹）打开右栏时显示 Now 页签：任务、计划、交付；右栏任何时候都有内容，读不到时说原因并能重试。',
  timeout: 900,
};

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);

const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
const run = promisify(execFile);
/** The instance's own dispatch CLI in the instance's environment, plus `extra` (an agent's DISPATCH_SESSION_ID). */
async function cli(ui, extra, ...args) {
  const bootstrap = "import os,sys,json; r=json.loads(sys.argv[1]); x=json.loads(sys.argv[2]); sys.path.insert(0,os.path.dirname(r['cli'])); import ide_e2e as E; env=dict(E.instance_env(r)); env.update(x); os.execve(sys.executable,[sys.executable,r['cli'],*sys.argv[3:]],env)";
  const r = await run('python3', ['-c', bootstrap, JSON.stringify(ui.rec), JSON.stringify(extra || {}), ...args], { env: process.env, maxBuffer: 16 * 1024 * 1024, timeout: 240000 });
  return r.stdout;
}

/** What the side pane shows right now: each visible part on the right of the chat, its tabs and whether anything in it
 *  can be read. `blank` names a part that is open and shows nothing (no words, no picture, no page). */
const PANE = `(() => {
  const seen = e => { if (!e) return false; const b = e.getBoundingClientRect(); const s = getComputedStyle(e); return b.width > 40 && b.height > 40 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
  const words = e => [...e.querySelectorAll('*')].filter(x => !x.children.length && seen(x.parentElement) && x.getBoundingClientRect().width > 0)
    .map(x => (x.textContent || '').trim()).filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();
  const out = { parts: [], blank: [] };
  for (const [name, sel, body] of [['editor', '.part.editor', '.editor-group-container .editor-container, .dispatch-side-empty.shown'], ['detail', '.part.auxiliarybar', '.content']]) {
    const p = document.querySelector(sel);
    if (!seen(p)) continue;
    const tabs = [...p.querySelectorAll('.tabs-container .tab')].map(t => t.getAttribute('aria-label') || t.textContent.trim());
    const b = [...p.querySelectorAll(body)].filter(seen);
    const text = b.map(words).join(' ').trim();
    const media = b.some(x => x.querySelector('iframe, webview, canvas, img, .monaco-editor .view-lines, .monaco-list-row'));
    const box = p.getBoundingClientRect();
    out.parts.push({ name, box: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)], tabs, text: text.slice(0, 300), media });
    if (!text && !media) out.blank.push(name);
  }
  return out;
})()`;
const pane = ui => ui.eval(PANE);
const ROWS = `[...document.querySelectorAll('.sessions-list-control .monaco-list-row')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`;
const rowsLog = [];
async function noteRows(ui, when) { rowsLog.push({ when, rows: await ui.eval(ROWS) }); fs.writeFileSync(path.join(ui.out, 'rows.json'), JSON.stringify(rowsLog, null, 1)); }

/** The side pane, looked at for a few seconds: it must never sit blank (a pane still sliding in gets a moment). */
async function neverBlank(ui, where, name) {
  let last;
  for (let i = 0; i < 8; i++) {
    await ui.sleep(i ? 1000 : 1500);
    last = await pane(ui);
    if (i >= 2 && last.blank.length) break;
  }
  fs.writeFileSync(path.join(ui.out, `${name}.json`), JSON.stringify(last, null, 1));
  await ui.screenshot(name);
  assert(!last.blank.length, `${where}: the side pane is open and blank (${last.blank.join(', ')}): ${JSON.stringify(last)}`);
  assert(last.parts.length, `${where}: the side pane is not open: ${JSON.stringify(last)}`);
  return last;
}

async function until(ui, fn, timeoutMs, what, every = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs * SCALE) { const v = await fn(); if (v) return v; await ui.sleep(every); }
  throw new Error(`timed out waiting for ${what}`);
}

async function closeTips(ui) {
  for (let i = 0; i < 6 && await ui.exists({ css: '.dispatch-tour-close' }); i++) { await ui.click({ css: '.dispatch-tour-close' }); await ui.sleep(400); }
}

/** A new plain chat (no folder), the way a person starts one: the + on the side bar's Chats row. */
async function newChat(ui) {
  await ui.closeOverlays();
  await ui.hover({ text: 'Chats', exact: true, within: '.part.sidebar', webview: false });
  await ui.sleep(400);
  await ui.click({ aria: 'New Quick Chat', exact: true, within: '.part.sidebar', webview: false });
  await ui.waitFor({ css: '.sessions-chat-session-type-picker' }, { timeoutMs: 30000 });
}

/** Back to the chat by its row in Chats (OpenCode names the chat itself a little after its first reply: the title is
 *  read again each time); rows.json keeps what the list showed. */
async function pickChat(ui) {
  const title = await ui.eval(`document.querySelector('.part.titlebar .window-title, .part.titlebar')?.innerText || ''`);
  await noteRows(ui, 'picking the chat');
  const want = await ui.eval(`(() => { const rows = [...document.querySelectorAll('.sessions-list-control .monaco-list-row')]; const at = rows.findIndex(r => r.innerText.trim() === 'Chats'); const r = at >= 0 ? rows[at + 1] : null; return r ? r.innerText.split('\\n').map(s => s.trim()).filter(Boolean)[0] : ''; })()`);
  assert(want && want !== 'No chats', 'the chat is not under Chats: ' + JSON.stringify(rowsLog.at(-1)) + ' / ' + title);
  await ui.click({ text: want, within: '.sessions-list-control', webview: false });
  await ui.sleep(1500);
  return want;
}

/** The side pane's toggle on the title bar, the way a person opens it. */
async function openSidePane(ui) {
  if (await ui.exists({ aria: 'Show side panel', webview: false })) {
    await ui.click({ aria: 'Show side panel', webview: false });
    await ui.sleep(1500);
  }
}

export default async function (ui) {
  try { await ui.openAgents(ui.demoFolder); } catch (e) { if (!/editor window/.test(String(e && e.message))) throw e; await ui.openAgents(); }
  await ui.sleep(1500);
  await closeTips(ui);

  // 1. a chat in Chats, on OpenCode's cheap model, one short reply
  await newChat(ui);
  await ui.pickEngine('OpenCode', 180000);
  await ui.pickCheapModel();
  await ui.click({ css: '.sessions-chat-editor .monaco-editor .view-lines' });
  await ui.type('Reply with the single word OK. Do not use tools.');
  await ui.press('Enter', { send: true });
  // the reply: the last answer in the chat has stopped loading and has words in it (a short reply can come and go
  // before a running mark in the list is ever seen)
  await until(ui, () => ui.eval(`(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return !!r && !r.classList.contains('chat-response-loading') && /\\w/.test(r.innerText); })()`), 300000, 'the reply', 2000);
  await ui.sleep(1500);
  await closeTips(ui);
  await ui.screenshot('01-chat-replied');

  // 2. the side pane opened on the chat by its title-bar toggle: never blank; the Now tab speaks for this chat
  await openSidePane(ui);
  const first = await neverBlank(ui, 'chat, side pane opened', '02-chat-side-pane');
  assert(first.parts.some(p => p.tabs.some(t => /^Now/.test(t))), 'the chat has no Now tab in its side pane: ' + JSON.stringify(first));
  await ui.openNowTab();
  const key = await ui.eval(`document.querySelector('.dispatch-now-tab')?.dataset.session || ''`);
  assert(key, 'the Now tab does not say which session it speaks for');
  const sid = key.replace(/^[a-z][\w+.-]*:\/*/i, '').split('/').pop();

  // 3. a new chat's page with the side pane open (it stays open from the chat): not blank, it says how it starts
  await ui.newSession();
  await ui.sleep(2500);
  const fresh = await pane(ui);
  if (fresh.parts.length) {
    await neverBlank(ui, 'new chat page, side pane open', '03-new-chat-page');
    // no Now tab before the first message (user 2026-10-10): the pane's own empty state says how it starts
    assert(await ui.exists({ text: 'Nothing here yet', within: '.dispatch-side-empty' }), 'the new chat page\'s side pane does not say how it starts: ' + JSON.stringify(await pane(ui)));
    await ui.mark({ css: '.dispatch-side-empty' }, { what: '新对话页的右栏：空状态', where: 'New 之后，右栏开着时', how: '发第一条消息后这里出现 Now 页签：任务、计划和交付' });
  } else {
    fs.writeFileSync(path.join(ui.out, '03-new-chat-page.json'), JSON.stringify(fresh, null, 1));
    await ui.screenshot('03-new-chat-page');
  }

  // 4. the person's path in 0.9.2: from that page the chat picked in Chats, with the side pane open
  await openSidePane(ui);
  await pickChat(ui);
  await neverBlank(ui, 'chat picked with the side pane open', '04-chat-picked');

  // 5. the side pane closed and opened again on the chat: still something to read
  if (await ui.exists({ aria: 'Hide side panel', webview: false })) {
    await ui.click({ aria: 'Hide side panel', webview: false });
    await ui.sleep(1200);
  }
  await openSidePane(ui);
  await neverBlank(ui, 'chat, side pane closed and opened again', '05-chat-reopened');

  // 6. the board cannot be read (Dispatch: Command Location set to a dispatch that is not there): the Now tab says
  //    why and offers Try again; with the setting put back, Try again reads again
  const settings = [ui.rec.user_data_dir, ui.rec.agents_user_data_dir].filter(Boolean).map(d => path.join(d, 'User', 'settings.json'));
  const before = settings.map(f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
  try {
    settings.forEach((f, i) => fs.writeFileSync(f, JSON.stringify({ ...(before[i] ? JSON.parse(before[i]) : {}), 'dispatch.commandLocation': path.join(ui.out, 'no-such-dispatch') }, null, 2)));
    await ui.sleep(2000);
    // the chat picked again from another page: the tab reads anew and the read fails
    await ui.newSession();
    await ui.sleep(1500);
    await pickChat(ui);
    await ui.openNowTab();
    await ui.waitFor({ css: '.dispatch-now-failed .dispatch-now-retry' }, { timeoutMs: 45000 });
    const why = await ui.eval(`document.querySelector('.dispatch-now-failed .dispatch-now-why')?.textContent || ''`);
    fs.writeFileSync(path.join(ui.out, '06-failed-why.txt'), why);
    assert(/no-such-dispatch/.test(why), 'the failure does not say why: ' + why);
    await neverBlank(ui, 'board cannot be read', '06-chat-failed');
    await ui.mark({ css: '.dispatch-now-failed' }, { what: '读不到任务板：原因和 Try again', where: '会话右栏 Now 页签', how: '点 Try again 立刻再读，平时每隔几秒也自己重试' });
  } finally {
    settings.forEach((f, i) => before[i] === null ? fs.rmSync(f, { force: true }) : fs.writeFileSync(f, before[i]));
  }
  await ui.sleep(1200);
  // the tab also tries again by itself every few seconds: it may have beaten the click to it
  const clicked = await ui.exists({ css: '.dispatch-now-failed .dispatch-now-retry' });
  if (clicked) await ui.click({ css: '.dispatch-now-failed .dispatch-now-retry' });
  fs.writeFileSync(path.join(ui.out, '07-try-again.txt'), clicked ? 'clicked Try again' : 'the tab read again by itself first');
  await ui.waitFor({ text: 'No task yet', within: '.dispatch-now-tab' }, { timeoutMs: 45000 });
  assert(!(await ui.exists({ css: '.dispatch-now-failed' })), 'with the board back the failure is still shown');
  await neverBlank(ui, 'after Try again', '07-chat-tried-again');

  // 7. the chat gets a task the way an agent records one, and delivers a draft: the Now tab shows both
  const agent = { DISPATCH_SESSION_ID: sid };
  await noteRows(ui, 'before the task');
  const said = await cli(ui, agent, 'begin', 'Reschedule email: Monday 8 am appointment', '--session', sid, '--force', '--json', '-d', 'Seeded by the right-pane-chat scenario: a chat without a folder with a delivered task.');
  const begun = JSON.parse(said.slice(said.indexOf('{')));
  const tid = begun.id || begun.task?.id;
  assert(tid, 'begin gave no task id: ' + JSON.stringify(begun));
  await cli(ui, agent, 'task', 'deliver', tid, '--draft', 'Reschedule email draft', '--label', 'Email draft');
  await ui.waitFor({ text: 'Reschedule email', within: '.dispatch-now-tab' }, { timeoutMs: 45000 });
  await ui.waitFor({ text: 'Email draft', within: '.dispatch-now-tab' }, { timeoutMs: 45000 });
  await noteRows(ui, 'task delivered');
  await neverBlank(ui, 'chat with a delivered task', '08-chat-delivered');
  await ui.mark({ css: '.dispatch-now-tab' }, { what: '无文件夹会话的右栏：Now 页签', where: '会话右侧', how: '任务、交付都在这里，点交付打开' });
}
