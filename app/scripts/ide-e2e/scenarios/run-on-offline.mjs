// Run on, when the other Mac does not answer (kanban task-qb6j; Dispatch IDE patches/280-run-on.patch):
// the way a person meets it with the mini asleep or away. The instance knows one other Mac, as if it had been added
// in Settings › Macs, at an address that never answers (DISPATCH_E2E_RUN_ON_OFFLINE="user@address name", default
// TEST-NET-1 192.0.2.1 named mini, so the scenario does not depend on where the real mini is). The new session page
// says "This Mac"; the menu lists the other Mac as not reachable right now; picking it anyway says "Connecting to …",
// then one plain notification says what to check (not the SSH error), and the page stays on this Mac.
// One machine is enough: no SSH login, no engine messages.
import fs from 'node:fs';
import path from 'node:path';

export const meta = {
  title: '选的那台 Mac 连不上时',
  description: '新建会话页 Run on 菜单里，连不上的 Mac 写 Not reachable right now；硬选它，胶囊先说 Connecting，随后一条通知用大白话说该查什么，页面留在 This Mac。',
  timeout: 240,
};

function assert(ok, message) { if (!ok) throw new Error(message); }

const [TARGET, NAME] = (process.env.DISPATCH_E2E_RUN_ON_OFFLINE || 'apple@192.0.2.1 mini').split(/\s+/);
const CHIP = '.dispatch-run-on .action-label';
const TOAST = { css: '.notification-toast-container .notification-list-item', webview: false };

const chipText = (ui) => ui.eval(`document.querySelector('${CHIP}')?.innerText.trim() || ''`);
const pickerRow = (ui) => ui.eval("document.querySelector('.new-session-workspace-picker-container')?.innerText.replace(/\\s+/g, ' ').trim() || ''");
const toastText = (ui) => ui.eval("[...document.querySelectorAll('.notification-toast-container .notification-list-item')].map(e => e.innerText.replace(/\\s+/g, ' ').trim()).join(' | ')");
const menuRows = (ui) => ui.eval("[...document.querySelectorAll('.context-view .monaco-list-row')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())");

/** First-run tips sit beside the side bar, over the new session page's chips: out of the way, as a person would close them. */
async function closeTips(ui) {
  for (let i = 0; i < 6 && await ui.exists({ css: '.dispatch-tour-close' }); i++) { await ui.click({ css: '.dispatch-tour-close' }); await ui.sleep(400); }
}

async function waitFor(ui, what, fn, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`${what}: not after ${timeoutMs / 1000} s`);
    await ui.sleep(300);
  }
}

export default async function (ui) {
  const facts = { target: TARGET, name: NAME };
  // the other Mac, as Settings › Macs would have added it
  fs.writeFileSync(path.join(ui.rec.dispatch_dir, 'hosts.json'), JSON.stringify([{ id: NAME, name: NAME, ssh: TARGET }], null, 2));

  await ui.openAgents();
  await ui.sleep(3000);
  await ui.newSession();
  await ui.sleep(1500);
  // 1. a new session runs on this Mac
  await ui.waitFor({ css: CHIP }, { timeoutMs: 30000 });
  facts.chipBefore = await chipText(ui);
  assert(facts.chipBefore === 'This Mac', `the chip says "${facts.chipBefore}"`);
  facts.rowBefore = await pickerRow(ui);

  // 2. the menu says the other Mac cannot be reached right now (it asks again when the menu opens)
  await closeTips(ui);
  await ui.click({ css: CHIP });
  await ui.waitFor({ text: NAME, exact: true, within: '.context-view' }, { timeoutMs: 30000 });
  facts.menu = await waitFor(ui, 'the menu to say whether the other Mac answers', async () => {
    const rows = await menuRows(ui);
    return rows.some(r => r.startsWith(NAME) && /Not reachable right now|Online/.test(r)) ? rows : null;
  }, 60000);
  assert(facts.menu.some(r => r.startsWith('This Mac')) && facts.menu.some(r => r.startsWith('Add another Mac')), `menu: ${facts.menu.join(' | ')}`);
  assert(facts.menu.some(r => r.startsWith(NAME) && r.includes('Not reachable right now')), `the menu does not say ${NAME} is out of reach: ${facts.menu.join(' | ')}`);
  await ui.screenshot('01-menu-not-reachable');
  await ui.mark({ text: NAME, exact: true, within: '.context-view' }, { what: '连不上的 Mac', where: '新建会话页 Run on 菜单', how: '名字后面写 Not reachable right now' });

  // 3. picked anyway: "Connecting to …", then one notification in plain words, and the page stays here
  const t0 = Date.now();
  await ui.click({ text: NAME, exact: true, within: '.context-view' });
  facts.connecting = await waitFor(ui, 'Connecting to', async () => {
    const t = await ui.eval("document.body.innerText.match(/Connecting to [^\\n]*/)?.[0] || ''");
    return t || null;
  }, 10000).catch(() => '');
  facts.toast = await waitFor(ui, 'the notification', async () => {
    const t = await toastText(ui);
    return t.includes(NAME) ? t : null;
  }, 120000);
  facts.failSeconds = Math.round((Date.now() - t0) / 100) / 10;
  assert(/did not answer\. Check that it is on, awake and on the same network or Tailscale\./.test(facts.toast), `the notification: ${facts.toast}`);
  assert(!/ssh|port 22|exit 255|ETIMEDOUT/i.test(facts.toast), `the notification shows the SSH error: ${facts.toast}`);
  facts.chipAfter = await chipText(ui);
  facts.rowAfter = await pickerRow(ui);
  assert(facts.chipAfter === 'This Mac', `after the failure the chip says "${facts.chipAfter}"`);
  assert(!facts.rowAfter.includes(`[${NAME}]`), `the page moved to ${NAME}: ${facts.rowAfter}`);
  await ui.sleep(500);
  await ui.screenshot('02-did-not-answer');
  await ui.mark(TOAST, { what: '连不上时说该查什么', where: 'Agents 窗口右下角的通知', how: '选了连不上的 Mac 以后出现，胶囊仍是 This Mac' });
  await ui.mark({ css: CHIP }, { what: '仍在本机', where: '新建会话页 Run on 胶囊', how: '连不上就不换机器' });
  fs.writeFileSync(path.join(ui.out, 'facts.json'), JSON.stringify(facts, null, 2));
}
