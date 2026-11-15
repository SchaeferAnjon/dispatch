// The built-in browser's login identities, the way a person and an agent use them: open the browser, the
// identity button at the start of the address bar, add "Work" (the page opens again with it, signed out),
// a cookie set in Work is not seen by Default and is still there back in Work, an agent in a terminal lists
// the identities and opens a page "as Work" (`dispatch browser --ide … --profile Work`), then Work is
// removed. Last, `dispatch computer`: the helper ships inside the app, and either the person is asked
// (practice app, Allow pressed, fill + Save, Stop) or, without the Accessibility permission, the plain
// "turn it on" answer comes back.
// Start the instance with: dispatch ide instance start <name> --agents (or with the demo project).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';

export const meta = { exclusive: true, title: '内置浏览器的登录身份和电脑操作', description: '地址栏前的身份按钮：新建、切换、各存各的登录、删除；终端里的 Agent 按身份打开页面；dispatch computer 先问再做。' };

const sleep = ms => new Promise(r => setTimeout(r, ms));

function cli(ui, args, extraEnv = {}) {
  const env = { ...process.env, BEADS_DIR: ui.rec.beads_dir, DISPATCH_DIR: ui.rec.dispatch_dir, DISPATCH_HOME: ui.rec.dispatch_home, ...extraEnv };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE') || k.startsWith('CODEX_')) delete env[k];
  try {
    return JSON.parse(execFileSync('python3', [ui.rec.cli, ...args, '--json'], { env, encoding: 'utf8', timeout: 180000 }).trim().split('\n').pop());
  } catch (e) {
    const out = String(e.stdout || '').trim().split('\n').pop();
    if (out && out.startsWith('{')) return JSON.parse(out);
    throw e;
  }
}

function cliAsync(ui, args, extraEnv = {}) {
  const env = { ...process.env, BEADS_DIR: ui.rec.beads_dir, DISPATCH_DIR: ui.rec.dispatch_dir, DISPATCH_HOME: ui.rec.dispatch_home, ...extraEnv };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE') || k.startsWith('CODEX_')) delete env[k];
  return new Promise(resolve => execFile('python3', [ui.rec.cli, ...args, '--json'], { env, encoding: 'utf8', timeout: 180000 },
    (_err, stdout) => resolve(JSON.parse(String(stdout).trim().split('\n').pop() || '{}'))));
}

function sock(file, obj) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(file, () => c.write(JSON.stringify(obj) + '\n'));
    let data = '';
    c.on('data', d => { data += d; if (data.endsWith('\n')) { c.end(); resolve(JSON.parse(data)); } });
    c.on('error', reject);
  });
}

async function offscreen(port) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let n = 0;
  const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); pending.get(m.id)?.(m); pending.delete(m.id); };
  const call = (method, params = {}) => new Promise(res => { const id = ++n; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  let moved = 0;
  for (const t of (await call('Target.getTargets')).result.targetInfos.filter(t => t.type === 'page')) {
    const w = await call('Browser.getWindowForTarget', { targetId: t.targetId });
    if (w.result) { await call('Browser.setWindowBounds', { windowId: w.result.windowId, bounds: { left: -3000, top: 0, width: 1440, height: 900, windowState: 'normal' } }); moved++; }
  }
  ws.close();
  return moved;
}

const identityLabel = ui => ui.eval(`(() => { const b = [...document.querySelectorAll('.dispatch-browser-identity .monaco-button')].find(e => e.offsetParent); return b ? b.getAttribute('aria-label') : null; })()`);

async function openMenu(ui) {
  await ui.click({ css: '.dispatch-browser-identity .monaco-button' });
  await ui.waitFor({ css: '.quick-input-list .monaco-list-row' }, { timeoutMs: 10000 });
  return ui.eval(`[...document.querySelectorAll('.quick-input-list .monaco-list-row')].map(r => r.getAttribute('aria-label') || r.textContent.trim())`);
}

async function cookieOf(ui) {
  const page = await ui.browserPage('example.com');
  return page.eval('document.cookie');
}

export default async function (ui) {
  const results = {};
  // the Agents window: on the demo project when there is an editor window, else the one the app opened with
  try { await ui.openAgents(ui.demoFolder); } catch { await ui.attach('agents', 90000); }
  // keep the test windows off the person's screen (screenshots and real clicks still work there):
  // the Browser domain lives on the browser-level connection, not on a page's
  try { results.offscreen = await offscreen(ui.port); } catch (e) { results.offscreen = String(e && e.message || e); }
  await ui.sleep(2000);

  // 1 the built-in browser on a page, the identity button says Default
  // (a first-run tip popover can hold the keyboard: Escape closes it first, as a person would)
  await ui.press('Escape');
  await ui.sleep(300);
  await ui.press('F1');
  await ui.type('Open Integrated Browser');
  await ui.sleep(600);
  await ui.press('Enter');
  await ui.waitFor('Search or enter URL', { timeoutMs: 20000 });
  results.identityButtonsOnOpen = await ui.eval(`document.querySelectorAll('.dispatch-browser-identity').length`);
  await ui.type('https://example.com', { into: 'Search or enter URL' });
  await ui.press('Enter');
  await ui.browserPage('example.com', { timeoutMs: 30000 });
  await ui.sleep(1500);
  assert.equal(await identityLabel(ui), 'Browser profile: Default');
  await ui.screenshot('01-browser-default');
  await ui.mark({ css: '.dispatch-browser-identity .monaco-button' }, { what: '登录身份按钮', where: '内置浏览器地址栏最前面', how: '点它：切换、新建身份，把 Chrome 的登录导进来' });

  // 2 the menu, then a new identity "Work"
  const rows = await openMenu(ui);
  assert.ok(rows.some(r => r.includes('Default')), `menu rows: ${rows}`);
  assert.ok(rows.some(r => r.includes('New profile')), `menu rows: ${rows}`);
  assert.ok(rows.some(r => r.includes('Bring sign-ins from Chrome into Default')), `menu rows: ${rows}`);
  await ui.screenshot('02-identity-menu');
  await ui.click({ text: 'New profile...' });
  await ui.waitFor({ css: '.quick-input-box input' });
  await ui.type('Work');
  await ui.screenshot('03-name-identity');
  await ui.press('Enter');
  await ui.sleep(2500);
  assert.equal(await identityLabel(ui), 'Browser profile: Work');
  await ui.screenshot('04-browser-work');

  // 3 sign-ins are kept apart: a cookie set as Work is not there as Default, and is there again in Work
  {
    const page = await ui.browserPage('example.com');
    await page.eval(`document.cookie = 'dispatch_identity=work; max-age=3600; path=/'`);
  }
  results.cookieInWork = await cookieOf(ui);
  assert.match(results.cookieInWork, /dispatch_identity=work/);
  await openMenu(ui);
  await ui.click({ text: 'Default', exact: true });
  await ui.sleep(2500);
  assert.equal(await identityLabel(ui), 'Browser profile: Default');
  // the page opens again as Default; for a moment the Work page it replaces can still answer: read until it is gone
  for (let i = 0; i < 10; i++) {
    results.cookieInDefault = await cookieOf(ui);
    if (!/dispatch_identity/.test(results.cookieInDefault)) break;
    await ui.sleep(500);
  }
  assert.doesNotMatch(results.cookieInDefault, /dispatch_identity/);
  await openMenu(ui);
  await ui.click({ text: 'Work', exact: true });
  await ui.sleep(2500);
  results.cookieBackInWork = await cookieOf(ui);
  assert.match(results.cookieBackInWork, /dispatch_identity=work/);

  // 4 an agent in a terminal: list the identities, open a page as Work, see it in status
  results.profiles = cli(ui, ['browser', '--ide', 'profiles']);
  assert.ok(Array.isArray(results.profiles.profiles), `dispatch browser --ide profiles: ${JSON.stringify(results.profiles)}`);
  assert.deepEqual(results.profiles.profiles.map(p => p.name), ['Default', 'Work']);
  assert.equal(results.profiles.profiles.find(p => p.current).name, 'Work');
  results.openAsWork = cli(ui, ['browser', '--ide', 'open', 'https://example.org', '--profile', 'Work', '--as', 'claude']);
  assert.equal(results.openAsWork.ok, true, JSON.stringify(results.openAsWork));
  assert.equal(results.openAsWork.profile, 'Work');
  results.unknown = cli(ui, ['browser', '--ide', 'open', 'https://example.org', '--profile', 'Nobody']);
  assert.equal(results.unknown.ok, false);
  assert.match(results.unknown.error, /no browser profile called "Nobody"/);
  results.status = cli(ui, ['browser', '--ide', 'status']);
  assert.ok(results.status.pages.some(p => p.url.includes('example.org') && p.profile === 'Work'), JSON.stringify(results.status.pages));
  await ui.sleep(1500);
  await ui.screenshot('05-agent-opened-as-work');

  // 5 remove Work: the page goes back to Default, and Work is gone from the list
  await ui.click({ css: '.dispatch-browser-identity .monaco-button' });
  await ui.waitFor({ css: '.quick-input-list .monaco-list-row' });
  // the page in front (example.com or example.org) is a Work page either way
  const menu = await ui.eval(`[...document.querySelectorAll('.quick-input-list .monaco-list-row')].map(r => r.getAttribute('aria-label') || r.textContent.trim())`);
  assert.ok(menu.some(r => r.includes('Remove Work')), `menu: ${menu}`);
  await ui.screenshot('06-remove-in-menu');
  await ui.click({ text: 'Remove Work...' });
  await ui.waitFor({ text: 'Remove the profile Work?' }, { timeoutMs: 10000 });
  await ui.screenshot('07-remove-confirm');
  await ui.click({ text: 'Remove', exact: true });
  await ui.sleep(2500);
  results.afterRemove = cli(ui, ['browser', '--ide', 'profiles']);
  assert.deepEqual(results.afterRemove.profiles.map(p => p.name), ['Default']);
  assert.equal(await identityLabel(ui), 'Browser profile: Default');
  await ui.screenshot('08-after-remove');

  // 6 computer use: the helper inside this build, then ask → Allow → act → Stop, or the permission answer
  const tools = ui.resources('tools');
  const cuEnv = { DISPATCH_IDE_BIN: tools, DISPATCH_COMPUTER_SELFTEST: '1', DISPATCH_COMPUTER_OFFSCREEN: '1' };
  results.check = cli(ui, ['computer', 'check'], cuEnv);
  assert.equal(results.check.helper, path.join(tools, 'dispatch-computer'), 'the helper ships inside the app');
  const helper = results.check.helper;
  // the helper in the app knows drag, menus and points (protocol 2)
  results.version = JSON.parse(execFileSync(helper, ['version'], { encoding: 'utf8' }).trim());
  assert.equal(results.version.protocol, 2);
  if (results.check.accessibility) {
    const notesOut = path.join(ui.out, 'practice.json');
    const notes = spawn(helper, ['practice', '--out', notesOut], { stdio: 'ignore', env: { ...process.env, ...cuEnv } });
    try {
      await sleep(1500);
      const sockPath = path.join(ui.rec.dispatch_dir, 'computer', 'session.sock');
      const pressAllow = (async () => {
        for (let i = 0; i < 60; i++) {
          await sleep(250);
          try { const r = await sock(sockPath, { cmd: 'ui', button: 'Allow' }); if (r.ok) return r; } catch { /* not up yet */ }
        }
        return null;
      })();
      [results.start] = await Promise.all([cliAsync(ui, ['computer', 'start', `pid:${notes.pid}`, '--why', 'write a test note', '--as', 'claude'], cuEnv), pressAllow]);
      // a test Mac whose screen has locked: the plain answer, at once, and nothing else to do here
      if (results.start.status === 'screen-locked') {
        assert.match(results.start.message, /screen is locked/);
        results.screenLocked = true;
        fs.writeFileSync(path.join(ui.out, 'results.json'), JSON.stringify(results, null, 2));
        return;
      }
      assert.equal(results.start.status, 'running', JSON.stringify(results.start));
      results.look = cli(ui, ['computer', 'look'], cuEnv);
      // a locked screen hides a new app's windows from the Accessibility tree: say so, do not guess
      results.practiceVisible = /button "Save"/.test(results.look.text || '');
      if (results.practiceVisible) {
        results.fill = cli(ui, ['computer', 'fill', 'Note', 'Hello from Claude'], cuEnv);
        results.click = cli(ui, ['computer', 'click', 'Save'], cuEnv);
        await sleep(500);
        results.practice = JSON.parse(fs.readFileSync(notesOut, 'utf8'));
        assert.equal(results.practice.saved, 'Saved: Hello from Claude');
        // where each part is, for clicks at a point
        results.frames = cli(ui, ['computer', 'look', '--frames'], cuEnv);
        assert.match(results.frames.text, /button "Save" @\d+,\d+ \d+x\d+/);
      }
      results.esc = cli(ui, ['computer', 'press', 'Esc'], cuEnv);
      assert.equal(results.esc.ok, false);
      // a click on the bar keeps the list of steps open under it
      results.pin = await sock(sockPath, { cmd: 'ui', button: 'Pin steps' });
      assert.equal(results.pin.pinned, true);
      await sleep(300);
      await sock(sockPath, { cmd: 'render', dir: ui.out });
      await sock(sockPath, { cmd: 'ui', button: 'Stop' });
      await sleep(400);
      // after Stop the agent hears that the person stopped it, and where the steps page is
      results.afterStop = cli(ui, ['computer', 'look'], cuEnv);
      assert.equal(results.afterStop.code, 'stopped', JSON.stringify(results.afterStop));
      results.status = cli(ui, ['computer', 'status'], cuEnv);
      const page = results.status.last && results.status.last.page;
      assert.ok(page && fs.existsSync(page), 'the steps page is kept: ' + JSON.stringify(results.status));
      if (results.practiceVisible) assert.match(fs.readFileSync(page, 'utf8'), /Clicked “Save”/);
    } finally {
      notes.kill('SIGTERM');
    }
  } else {
    results.start = cli(ui, ['computer', 'start', 'TextEdit', '--why', 'write a test note', '--wait', '20'], cuEnv);
    assert.equal(results.start.status, 'needs-permission', JSON.stringify(results.start));
    assert.match(results.start.message, /Accessibility/);
    try { process.kill(results.start.pid, 'SIGTERM'); } catch { /* gone */ }
  }
  fs.writeFileSync(path.join(ui.out, 'results.json'), JSON.stringify(results, null, 2));
}
