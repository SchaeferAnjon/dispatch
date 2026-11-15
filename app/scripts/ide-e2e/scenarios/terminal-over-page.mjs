// A terminal asked for while a page covers the Agents window (Settings here) shows under the page, which stays:
// Settings › Agents › OpenCode › Add Provider…, whose `opencode auth login` used to run in a panel no one could see (the new-user run on the 0.9.1 release, task-7mmi3).
import assert from 'node:assert/strict';

export const meta = { title: 'A terminal over a page', description: 'Settings stays up and the terminal shows under it, with the focus.', timeout: 300 };

const panelShown = ui => ui.eval(`(() => { const p = document.querySelector('.part.panel'); if (!p) return false; const r = p.getBoundingClientRect(); return !!p.offsetParent && r.height > 60; })()`);
const settingsShown = ui => ui.exists({ css: '.dispatch-settings-page', webview: false });
const terminalFocused = ui => ui.eval(`!!document.activeElement && !!document.activeElement.closest('.part.panel .terminal-wrapper, .part.panel .xterm')`);

export default async function (ui) {
  await ui.openAgents();
  await ui.closeOverlays();
  await ui.press('Cmd+,');
  await ui.waitFor({ css: '.part.sidebar.dispatch-settings-open .dispatch-settings-nav', webview: false }, { timeoutMs: 15000 });
  await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="agents"]', webview: false });
  assert.equal(await panelShown(ui), false, 'Settings covers the bottom panel to begin with');

  // Settings › Agents › OpenCode › Add Provider…: the terminal with OpenCode's own question
  const row = '.dispatch-settings-page .dset-row[data-agent="opencode"]';
  // the list asks every agent for its version and sign-in: on a busy build Mac that took over 20 s
  const t0 = Date.now();
  await ui.waitFor({ css: row, webview: false }, { timeoutMs: 90000 });
  const listed = Math.round((Date.now() - t0) / 1000);
  await ui.eval(`document.querySelector('${row}').scrollIntoView({ block: 'center' })`);
  await ui.sleep(300);
  await ui.click({ css: row, webview: false });
  // below the fold on a short window: there in the page first, then scrolled to
  for (let i = 0; i < 180 && !(await ui.eval(`!!document.querySelector('.opencode-settings-add-provider')`)); i++) await ui.sleep(500);
  await ui.eval(`document.querySelector('.opencode-settings-add-provider').scrollIntoView({ block: 'center' })`);
  await ui.click({ css: '.opencode-settings-add-provider', webview: false });
  for (let i = 0; i < 40 && !(await panelShown(ui)); i++) await ui.sleep(300);
  assert.equal(await panelShown(ui), true, "Add Provider's terminal shows under the page");
  assert.equal(await settingsShown(ui), true, 'Settings stays up while OpenCode asks');
  const tabs = await ui.eval(`document.querySelector('.part.panel')?.innerText || ''`);
  assert.match(tabs, /OpenCode/, `the panel has the OpenCode terminal (${tabs.replace(/\s+/g, ' ').slice(0, 120)})`);
  for (let i = 0; i < 20 && !(await terminalFocused(ui)); i++) await ui.sleep(250);
  assert.equal(await terminalFocused(ui), true, 'the terminal has the focus');
  await ui.screenshot('01-add-provider-terminal');
  await ui.mark({ css: '.part.panel' }, { what: 'Add Provider 的终端', where: 'Settings › Agents › OpenCode 下方', how: '点 Add Provider…，OpenCode 在这里问用哪家、填 key' });

  return { panel: true, agentsListedAfterSeconds: listed };
}
