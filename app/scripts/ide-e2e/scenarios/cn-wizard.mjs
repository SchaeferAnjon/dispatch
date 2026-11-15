// The setup wizard on a network that cannot reach Anthropic or OpenAI (task-ucbk). Start the instance with
// `--onboarding fresh` (a new user's HOME, engines that only answer --version). First screen as it opens on a network
// that works: no "From this network". Then this Mac's proxy becomes one that refuses Anthropic's and OpenAI's servers
// (a proxy this scenario runs on 127.0.0.1, set in the instance's own Dispatch folder with `dispatch net set proxy`),
// the window reloads, and the first screen says Claude Code and Codex cannot reach their servers, lists the Chinese
// models OpenCode can use with what each needs and where to get a key, and makes OpenCode the default.
import net from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const meta = { instance: { onboarding: 'fresh' }, title: 'Setup on a network that cannot reach Anthropic', description: 'The first screen of the setup wizard recommends OpenCode with Chinese models when Claude Code and Codex cannot reach their servers.', timeout: 600 };

function assert(v, m) { if (!v) throw new Error(m); }

function refusingProxy() {
  const blocked = [/(^|\.)anthropic\.com$/, /(^|\.)openai\.com$/, /(^|\.)chatgpt\.com$/];
  const server = net.createServer(sock => {
    sock.on('error', () => {});
    sock.once('data', buf => {
      const m = /^CONNECT ([^:\s]+):(\d+)/.exec(buf.toString('latin1'));
      if (!m || blocked.some(r => r.test(m[1].toLowerCase()))) { sock.destroy(); return; }
      const up = net.connect(Number(m[2]), m[1], () => {
        sock.write('HTTP/1.1 200 Connection established\r\n\r\n');
        up.pipe(sock);
        sock.pipe(up);
      });
      up.on('error', () => sock.destroy());
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => server.close() })));
}

function cli(ui, args) {
  const out = execFileSync(join(ui.rec.bin_dir, 'dispatch'), args, { encoding: 'utf8', timeout: 90000 });
  const i = Math.min(...['{', '['].map(c => out.indexOf(c)).filter(x => x >= 0));
  return JSON.parse(out.slice(i));
}

async function offScreen(ui) {
  try {
    const { windowId } = await ui.cdp.send('Browser.getWindowForTarget', {});
    await ui.cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -3000, top: -3000 } });
  } catch { /* the run still works */ }
}

const DEFAULT_ROW = `(() => { const t = [...document.querySelectorAll('.dispatch-onboarding .dob-row')].find(r => r.querySelector('.dob-tag')?.textContent === 'Default'); return t ? t.querySelector('.dob-n')?.textContent : ''; })()`;
const MAKERS = `[...document.querySelectorAll('.dispatch-onboarding .dnet-models .dob-row')].map(r => ({ maker: r.dataset.maker, text: r.innerText.replace(/\\s+/g, ' ').trim() }))`;

export default async function (ui) {
  assert(ui.rec.fixture_home, 'Start this instance with --onboarding fresh');
  const facts = {};
  const save = () => writeFileSync(`${ui.out}/facts.json`, JSON.stringify(facts, null, 2));
  const proxy = await refusingProxy();
  try {
    await ui.attach('agents', 60000);
    await offScreen(ui);
    await ui.waitFor('Agents on this Mac', { timeoutMs: 90000 });
    await ui.sleep(2500);
    facts.group_before = await ui.exists('From this network');
    facts.default_before = await ui.eval(DEFAULT_ROW);
    assert(!facts.group_before, 'the network group shows on a network that works');
    await ui.screenshot('01-wizard-network-fine');

    facts.set = cli(ui, ['net', 'set', 'proxy', `http://127.0.0.1:${proxy.port}`, '--json']).blocked;
    assert(facts.set.anthropic === true && facts.set.openai === true, `the check did not see the refusing proxy: ${JSON.stringify(facts.set)}`);
    await ui.cdp.send('Page.reload', {});
    await ui.sleep(3000);
    await ui.attach('agents', 60000);
    await offScreen(ui);
    await ui.waitFor('From this network', { timeoutMs: 120000 });
    await ui.sleep(1500);
    facts.say = await ui.eval(`document.querySelector('.dispatch-onboarding .dnet-say')?.textContent || ''`);
    facts.makers = await ui.eval(MAKERS);
    facts.default_after = await ui.eval(DEFAULT_ROW);
    assert(/cannot reach Anthropic/.test(facts.say), facts.say);
    assert(facts.makers.length === 4, JSON.stringify(facts.makers));
    await ui.scrollTo('From this network');
    await ui.mouse('mouseMoved', 1300, 640);
    await ui.sleep(500);
    await ui.screenshot('02-wizard-network-blocked');
    await ui.mark({ css: '.dispatch-onboarding .dnet-say' }, { what: '这个网络连不上 Anthropic / OpenAI，推荐 OpenCode', where: '首次设置第一屏，引擎列表下面', how: '打开时自动检查网络' });
    await ui.mark({ css: '.dispatch-onboarding .dnet-models .dob-row[data-maker="zhipu"]' }, { what: '国产模型：要什么账号、去哪拿 Key', where: 'From this network 列表', how: '点 Get a key 打开官网的 Key 页' });
    if (facts.default_after) await ui.mark({ css: '.dispatch-onboarding .dob-tag' }, { what: '默认引擎换成 OpenCode', where: '引擎行右边', how: '没手动选过默认时自动' });
  } finally {
    proxy.close();
    save();
  }
}
