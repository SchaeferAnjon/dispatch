// A network that cannot reach Anthropic or OpenAI, as many in mainland China (task-ucbk). The person's path: the new
// session page first, with nothing in the way; Settings › Network, "Use this proxy…", the proxy app's address (here
// a proxy this scenario runs on 127.0.0.1 that refuses Anthropic's and OpenAI's servers, like such a network, and
// lets everything else through); the page says which servers do not answer; Restart agents now. A new Claude Code
// session then says Claude Code cannot reach Anthropic, Use OpenCode switches new sessions to OpenCode; with GLM 5.3
// Flash a message goes out while the proxy drops every connection (the network is down): the conversation says it
// lost the connection and will try again, the network comes back, the same message goes out again and the reply
// arrives. Nothing outside the instance changes: the proxy is set in the instance's own Dispatch folder.
import net from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)

export const meta = { needs: ['opencode'], title: 'From a network that cannot reach Anthropic', description: 'Settings › Network with a proxy, the notice on a new Claude Code session, Use OpenCode, and a message that survives a dropped connection.', timeout: 1500 };

const fresh = '.sessions-chat-editor';
const NAV = { css: '.part.sidebar.dispatch-settings-open .dispatch-settings-nav', webview: false };
const MESSAGE = 'Reply with the single word pong and nothing else.';

function assert(v, m) { if (!v) throw new Error(m); }

/** A proxy on 127.0.0.1 that the run controls: `blocked` hosts and everything while `down` get their connection
 *  closed at once (what a refused or dropped connection looks like to the engines); the rest is tunnelled through. */
function controlProxy() {
  const state = { down: false, blocked: [/(^|\.)anthropic\.com$/, /(^|\.)openai\.com$/, /(^|\.)chatgpt\.com$/], hosts: {}, open: new Set() };
  const server = net.createServer(sock => {
    state.open.add(sock);
    sock.on('close', () => state.open.delete(sock));
    sock.on('error', () => {});
    sock.once('data', buf => {
      const m = /^CONNECT ([^:\s]+):(\d+)/.exec(buf.toString('latin1'));
      if (!m) { sock.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n'); return; }
      const host = m[1].toLowerCase();
      const refused = state.down || state.blocked.some(r => r.test(host));
      state.hosts[host] = (state.hosts[host] || { through: 0, refused: 0 });
      state.hosts[host][refused ? 'refused' : 'through']++;
      if (refused) { sock.destroy(); return; }
      const up = net.connect(Number(m[2]), host, () => {
        sock.write('HTTP/1.1 200 Connection established\r\n\r\n');
        const rest = buf.subarray(buf.indexOf('\r\n\r\n') + 4);
        if (rest.length) up.write(rest);
        up.pipe(sock);
        sock.pipe(up);
      });
      state.open.add(up);
      up.on('close', () => state.open.delete(up));
      up.on('error', () => sock.destroy());
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, state,
    setDown(down) { state.down = down; if (down) { for (const s of state.open) s.destroy(); } },
    close() { for (const s of state.open) s.destroy(); server.close(); },
  })));
}

function cli(ui, args) {
  const out = execFileSync(join(ui.rec.bin_dir, 'dispatch'), args, { encoding: 'utf8', timeout: 90000 });
  const i = Math.min(...['{', '['].map(c => out.indexOf(c)).filter(x => x >= 0));
  return JSON.parse(out.slice(i));
}

async function until(ui, fn, what, ms = 120000, every = 1000) {
  const end = Date.now() + ms * SCALE;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await ui.sleep(every);
  }
  throw new Error(`Timed out: ${what}`);
}

async function offScreen(ui) {
  try {
    const { windowId } = await ui.cdp.send('Browser.getWindowForTarget', {});
    await ui.cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -3000, top: -3000 } });
  } catch { /* the run still works */ }
}

async function closeTips(ui) {
  for (let i = 0; i < 5 && (await ui.exists({ css: 'button.dispatch-tour-close' })); i++) {
    await ui.click({ css: 'button.dispatch-tour-close' });
    await ui.sleep(600);
  }
}

async function restPointer(ui) {
  await ui.mouse('mouseMoved', 1300, 640);
  await ui.sleep(500);
}

async function focusInput(ui, css = fresh) {
  for (let i = 0; i < 8; i++) {
    await ui.click({ css: i % 2 ? `${css} .view-lines` : css });
    await ui.sleep(400);
    if (await ui.eval(`!!document.activeElement && !!document.activeElement.closest('${css}')`)) return;
    await ui.sleep(800);
  }
  throw new Error('The message box does not take the focus');
}

/** The cheap test model from the slash menu (GLM 5.3 Flash, DeepSeek Flash, else a free OpenCode Zen model: ui.cheapModel). */
async function pickModel(ui) {
  await focusInput(ui);
  await ui.type('/model');
  await ui.waitFor({ css: '.dispatch-slash-menu .dsm-row' }, { timeoutMs: 30000 });
  let seen = '';
  const row = await until(ui, async () => {
    const rows = await ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row')].map(r => ({name:r.querySelector('.dsm-name')?.textContent}))`);
    seen = rows.map(r => r.name).join(', ');
    return ui.cheapModel(rows);
  }, 'a test model', 60000).catch(e => { throw new Error(`${e.message}; the menu had: ${seen}`); });
  const typed = async () => ui.eval(`document.querySelector('${fresh} .view-lines')?.textContent || ''`);
  for (let i = 0; i < 40 && (await typed()).trim(); i++) await ui.press('Backspace');
  await ui.type(`/${row.name.replace(/\s+/g, '')}`);
  await until(ui, async () => ui.eval(`[...document.querySelectorAll('.dispatch-slash-menu .dsm-row .dsm-name')].some(n => n.textContent === ${JSON.stringify(row.name)})`), `the menu row ${row.name}`, 20000);
  await ui.click({ text: row.name, exact: true, within: '.dispatch-slash-menu' });
  await ui.press('Escape');
  return row.name;
}

const NOTICE = `(() => { const n = [...document.querySelectorAll('.chat-input-notification-widget')].find(e => e.getBoundingClientRect().width > 0); return n ? n.innerText.replace(/\\s+/g, ' ').trim() : ''; })()`;
const PICKER = `document.querySelector('.sessions-chat-session-type-picker')?.innerText.trim() || ''`;

async function openNetwork(ui) {
  if (!(await ui.exists(NAV))) {
    await ui.press('Cmd+,');
    await ui.waitFor(NAV, { timeoutMs: 15000 });
  }
  await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="network"]', webview: false });
  await ui.waitFor({ css: '.dispatch-settings-page .dset-rows[data-setting="net-servers"]', webview: false }, { timeoutMs: 90000 });
}

const SERVERS = `[...document.querySelectorAll('.dispatch-settings-page .dset-row[data-server]')].map(r => ({ server: r.dataset.server, ok: r.dataset.ok, text: r.innerText.replace(/\\s+/g, ' ').trim() }))`;

export default async function (ui) {
  const facts = { steps: [] };
  const save = () => writeFileSync(`${ui.out}/facts.json`, JSON.stringify(facts, null, 2));
  const proxy = await controlProxy();
  facts.proxy = `http://127.0.0.1:${proxy.port}`;
  try {
    await run(ui, proxy, facts, save);
  } finally {
    facts.proxy_hosts = proxy.state.hosts;
    proxy.close();
    save();
  }
}

async function run(ui, proxy, facts, save) {
  await ui.openAgents(ui.demoFolder);
  await offScreen(ui);
  await ui.sleep(4000);
  await closeTips(ui);

  // 0 before: a new Claude Code session on a network that works, nothing above the input
  await ui.newSession();
  await ui.pickEngine('Claude Code');
  await ui.sleep(3000);
  facts.notice_before = await ui.eval(NOTICE);
  assert(!facts.notice_before, `a notice before the proxy was set: ${facts.notice_before}`);
  await restPointer(ui);
  await ui.screenshot('01-new-session-before');

  // 1 Settings › Network: the proxy app's address
  await openNetwork(ui);
  facts.servers_before = await ui.eval(SERVERS);
  await ui.screenshot('02-network-page');
  await ui.mark({ css: '.dispatch-settings-nav .dsn-row[data-page="network"]', webview: false }, { what: '新的 Network 页', where: '设置左栏 Keep awake 下面', how: '⌘, 打开设置，点 Network' });
  await ui.scrollTo("Use this proxy…");
  await ui.click({ css: '.dispatch-settings-page .dset-choice[data-choice="custom"]', webview: false });
  await ui.waitFor({ css: '.quick-input-widget .input' }, { timeoutMs: 10000 });
  await ui.press('End');
  for (let i = 0; i < 40; i++) await ui.press('Backspace');
  await ui.type(facts.proxy);
  await ui.press('Enter');
  facts.saved = cli(ui, ['net', 'status', '--json']).proxy;
  assert(facts.saved.setting === facts.proxy, `the proxy was not saved: ${JSON.stringify(facts.saved)}`);
  await until(ui, async () => {
    const rows = await ui.eval(SERVERS);
    return rows.some(r => r.server === 'anthropic' && r.ok === 'false') ? rows : null;
  }, 'Anthropic marked as not reachable', 90000);
  facts.servers_after = await ui.eval(SERVERS);
  assert(facts.servers_after.find(r => r.server === 'npm')?.ok === 'true', 'npm should still answer through the proxy');
  await ui.eval(`document.querySelector('.dispatch-settings-page .dset-rows[data-setting="net-servers"]')?.scrollIntoView({ block: 'start' })`);
  await restPointer(ui);
  await ui.screenshot('03-network-blocked');
  await ui.mark({ css: '.dispatch-settings-page .dset-row[data-server="anthropic"]', webview: false }, { what: 'Anthropic 连不上（经这个代理）', where: 'Network 页第一组', how: '选 Use this proxy… 填代理地址后自动检查' });
  await ui.mark({ css: '.dispatch-settings-page .dset-choice[data-choice="custom"]', webview: false }, { what: '代理：本机设置 / 不用 / 自己填', where: 'Network 页 Proxy 组', how: '点一行；自己填时弹输入框' });
  save();

  // the agents start again with the proxy (Restart agents now)
  await ui.scrollTo('Restart agents now');
  await ui.click({ text: 'Restart agents now', exact: true });
  await ui.sleep(8000);
  await ui.press('Escape');
  await ui.sleep(1500);

  // 2 a new Claude Code session says it cannot reach Anthropic; Use OpenCode
  await ui.newSession();
  await ui.pickEngine('Claude Code');
  facts.notice = await until(ui, async () => {
    const t = await ui.eval(NOTICE);
    return /cannot reach Anthropic/.test(t) ? t : null;
  }, 'the notice on a new Claude Code session', 90000);
  await restPointer(ui);
  await ui.screenshot('04-new-session-notice');
  await ui.mark({ css: '.chat-input-notification-widget' }, { what: 'Claude Code 连不上 Anthropic 的提示', where: '新会话输入框上方', how: '网络连不上 Anthropic 时自动出现' });
  await ui.mark({ text: 'Use OpenCode', exact: true }, { what: '一键换成 OpenCode', where: '提示里的按钮', how: '点它，新会话改用 OpenCode' });
  await ui.click({ text: 'Use OpenCode', exact: true });
  await until(ui, async () => (await ui.eval(PICKER)) === 'OpenCode', 'the picker on OpenCode', 120000);
  facts.default_agent = cli(ui, ['engines', 'enabled', '--json']).default;
  assert(facts.default_agent === 'opencode', `default is ${facts.default_agent}`);
  await ui.sleep(1500);
  await restPointer(ui);
  await ui.screenshot('05-switched-to-opencode');
  save();

  // 3 a message while the connection is down: kept, sent again, answered
  await ui.pickEngine('OpenCode', 360000);
  facts.model = await pickModel(ui);
  await focusInput(ui);
  await ui.type(MESSAGE);
  proxy.setDown(true);
  facts.sent_at = Date.now();
  await ui.press('Enter', { send: true });
  facts.reconnecting = await until(ui, async () => ui.eval(`(() => { const t = document.querySelector('.interactive-list')?.innerText || ''; const m = /Lost the connection[^\\n]*/.exec(t); return m ? m[0] : null; })()`), 'the reconnect line', 300000, 500);
  facts.reconnect_after_ms = Date.now() - facts.sent_at;
  proxy.setDown(false);
  await restPointer(ui);
  await ui.screenshot('06-reconnecting');
  await ui.mark({ css: '.interactive-request.system-initiated-request' }, { what: '断线：说人话的重连提示，消息保留', where: '会话里，出错那条下面', how: '网络断开时自动出现，几秒后自动重发' });
  save();
  facts.reply = await until(ui, async () => ui.eval(`(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return r && !r.classList.contains('chat-response-loading') && /pong/i.test(r.innerText) ? r.innerText.trim().slice(0, 200) : null; })()`), 'the reply after the reconnect', 300000);
  facts.replied_after_ms = Date.now() - facts.sent_at;
  await ui.sleep(1500);
  await restPointer(ui);
  await ui.screenshot('07-reply-after-reconnect');
  await ui.mark({ css: '.interactive-response.chat-most-recent-response' }, { what: '网回来后同一句话重发，回复到了', where: '会话最后一条回复', how: '不用重打，自动重发' });
  const through = Object.entries(proxy.state.hosts).filter(([h, v]) => v.through > 0).map(([h]) => h);
  facts.engine_used_proxy = through.some(h => /bigmodel|deepseek/.test(h));
  assert(facts.engine_used_proxy, `OpenCode did not go through the proxy: ${JSON.stringify(proxy.state.hosts)}`);
}
