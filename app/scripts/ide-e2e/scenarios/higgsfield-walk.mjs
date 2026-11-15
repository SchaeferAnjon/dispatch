// Higgsfield in the built-in browser, the way the built-in-browser skill says, up to the Generate button and
// not past it (no credits spent): open the image tool, see the phone page the narrow panel gets, lay the page
// out at a desktop width (`dispatch browser --ide size 1440x900`), turn down optional cookies, type a prompt
// without submitting, read the model, settings and the credits on Generate, then back to the panel's size.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';

export const meta = { needs: ['internet'], title: 'Higgsfield 走到 Generate 前', description: '内置浏览器里照技能走 Higgsfield 做图页，到 Generate 前停下' };

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
  try { await ui.openAgents(ui.demoFolder); } catch { await ui.attach('agents', 90000); }
  try { results.offscreen = await offscreen(ui.port); } catch (e) { results.offscreen = String(e && e.message || e); }
  await ui.sleep(2000);
  const url = 'https://higgsfield.ai/ai/image?model=nano-banana-pro';
  results.open = cli(ui, ['browser', '--ide', 'open', url, '--as', 'claude']);
  assert.equal(results.open.ok, true, JSON.stringify(results.open).slice(0, 400));
  const pg = results.open.page ? ['--page', results.open.page] : [];
  await ui.sleep(8000);
  const narrow = cli(ui, ['browser', '--ide', 'read', ...pg]);
  results.narrowHasPrompt = /textbox/.test(narrow.text || '');
  results.narrowHasGenerate = /button "Generate \d+"/.test(narrow.text || '');
  await ui.screenshot('01-narrow-panel');
  results.size = cli(ui, ['browser', '--ide', 'size', '1440x900', ...pg]);
  assert.equal(results.size.ok, true, JSON.stringify(results.size).slice(0, 400));
  await ui.sleep(6000);
  const save = (name, r) => { fs.writeFileSync(path.join(ui.out, name), (r && (r.text || r.error)) || ''); return r; };
  save('read-narrow.txt', narrow);
  // the page lays itself out again at the new width: read until the prompt box is there
  let wide = {};
  for (let i = 0; i < 6 && !/textbox/.test(wide.text || ''); i++) { if (i) await ui.sleep(3000); wide = save('read-wide.txt', cli(ui, ['browser', '--ide', 'read', ...pg])); }
  if (/Reject Non-Essential Cookies/.test(wide.text || '')) {
    results.cookies = cli(ui, ['browser', '--ide', 'click', 'Reject Non-Essential Cookies', ...pg]);
    await ui.sleep(1500);
    wide = save('read-wide.txt', cli(ui, ['browser', '--ide', 'read', ...pg]));
  }
  const box = /textbox[^\n]*?\[ref=(e\d+)\]/.exec(wide.text || '');
  assert.ok(box, 'a prompt box at a desktop width');
  results.type = cli(ui, ['browser', '--ide', 'type', box[1], 'A red bicycle leaning on a stone wall at sunset', ...pg]);
  assert.equal(results.type.ok, true, JSON.stringify(results.type).slice(0, 400));
  await ui.sleep(1500);
  const after = save('read-after.txt', cli(ui, ['browser', '--ide', 'read', ...pg]));
  results.prompt = /A red bicycle leaning on a stone wall at sunset/.test(after.text || '');
  results.generate = (/button "(Generate \d+)"/.exec(after.text || '') || [])[1];
  results.model = (/generic \[ref=e\d+\]: (Nano Banana Pro|[A-Z][\w .-]+ Pro)/.exec(after.text || '') || [])[1];
  assert.ok(results.prompt, 'the prompt is in the box');
  assert.ok(results.generate, 'Generate shows the credits');
  results.shot = cli(ui, ['browser', '--ide', 'shot', '--out', path.join(ui.out, '03-page-before-generate.png'), ...pg]);
  await ui.screenshot('02-desktop-width-in-panel');
  // stop here: Generate is not pressed
  results.off = cli(ui, ['browser', '--ide', 'size', 'off', ...pg]);
  assert.equal(results.off.ok, true);
  fs.writeFileSync(path.join(ui.out, 'results.json'), JSON.stringify(results, null, 2));
}
