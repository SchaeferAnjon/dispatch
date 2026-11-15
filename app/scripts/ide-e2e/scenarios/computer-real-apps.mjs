// `dispatch computer` on real apps, on a test Mac's own screen (the Mac mini; never the person's Mac):
// Finder makes a folder in a temporary folder and a file is dragged into it; Notes gets a new note written in
// the background, which is then deleted for good. All the way: asked first (Allow pressed with the real mouse),
// only that app, the bar lists every step (hover opens it, a click keeps it open), Esc on the real keyboard
// stops it, and the app in front and the pointer are where they were. Only temporary things are touched:
// /tmp/dcu-e2e-finder and a note titled "Dispatch test note …", both gone at the end.
// Needs the Accessibility permission for the app the runner runs in; menu names are the Mac's language
// (Chinese or English). Run it on purpose: dispatch build start … --e2e app/scripts/ide-e2e/scenarios/computer-real-apps.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

export const meta = { exclusive: true, needs: ['accessibility'], title: '电脑操作：访达和备忘录真机', description: '先问再做、只动那个 App、后台优先、前台和鼠标还回去、Esc 停、每一步看得见；只碰临时文件夹和临时笔记' };

const sleep = ms => new Promise(r => setTimeout(r, ms));

function cli(ui, env, args) {
  const e = { ...process.env, BEADS_DIR: ui.rec.beads_dir, DISPATCH_DIR: ui.rec.dispatch_dir, DISPATCH_HOME: ui.rec.dispatch_home, ...env };
  for (const k of Object.keys(e)) if (k.startsWith('CLAUDE') || k.startsWith('CODEX_')) delete e[k];
  try {
    return JSON.parse(execFileSync('python3', [ui.rec.cli, 'computer', ...args, '--json'], { env: e, encoding: 'utf8', timeout: 120000, cwd: '/tmp' }).trim().split('\n').pop());
  } catch (err) {
    const out = String(err.stdout || '').trim().split('\n').pop();
    if (out && out.startsWith('{')) return JSON.parse(out);
    throw err;
  }
}

function sock(file, obj) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(file, () => c.write(JSON.stringify(obj) + '\n'));
    let data = '';
    c.on('data', d => { data += d; if (data.endsWith('\n')) { c.end(); resolve(JSON.parse(data)); } });
    c.on('error', reject);
  });
}

export default async function (ui) {
  const results = { steps: [] };
  let P;  // the person, set up below
  const log = (what, r) => {
    let front = '';
    try { front = P ? P('frontmost').name : ''; } catch { /* no person yet */ }
    results.steps.push({ what, ok: r && r.ok, in_front: !!(r && r.in_front), background: !!(r && r.background), did: r && (r.did || r.error), front_after: front });
    fs.writeFileSync(path.join(ui.out, 'results.json'), JSON.stringify(results, null, 2));
    return r;
  };
  const tools = ui.resources('tools');
  const env = { DISPATCH_IDE_BIN: tools, DISPATCH_COMPUTER_SELFTEST: '1' };
  const state = path.join(ui.rec.dispatch_dir, 'computer', 'session.json');
  const sockPath = path.join(ui.rec.dispatch_dir, 'computer', 'session.sock');
  const readState = () => { try { return JSON.parse(fs.readFileSync(state, 'utf8')); } catch { return {}; } };

  // the person: real mouse and keyboard, built from the fixture
  // next to the scenarios (the instance's own CLI copy has no scripts folder)
  const personSrc = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures', 'person.swift');
  const person = path.join(ui.out, 'person');
  execFileSync('xcrun', ['swiftc', '-O', '-o', person, personSrc], { timeout: 600000 });
  P = (...a) => JSON.parse(execFileSync(person, a.map(String), { encoding: 'utf8' }).trim());
  const C = (...a) => cli(ui, env, a);

  results.check = C('check');
  if (!results.check.accessibility) {
    fs.writeFileSync(path.join(ui.out, 'results.json'), JSON.stringify(results, null, 2));
    throw new Error('this Mac has not given the runner the Accessibility permission');
  }
  const zh = /zh/.test(execFileSync('defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8' }));
  const T = zh
    ? { file: '文件', newWindow: '新建“访达”窗口', go: '前往', goTo: '前往文件夹', newFolder: '新建文件夹', close: '关闭窗口', newNote: '新建备忘录', del: '删除', folders: '文件夹', recently: '最近删除' }
    : { file: 'File', newWindow: 'New Finder Window', go: 'Go', goTo: 'Go to Folder', newFolder: 'New Folder', close: 'Close Window', newNote: 'New Note', del: 'Delete', folders: 'Folders', recently: 'Recently Deleted' };

  // start a session and answer it like a person: the real mouse on Allow
  async function allow(app, why) {
    try { fs.unlinkSync(state); } catch { /* none */ }
    const started = new Promise(resolve => {
      const e = { ...process.env, BEADS_DIR: ui.rec.beads_dir, DISPATCH_DIR: ui.rec.dispatch_dir, DISPATCH_HOME: ui.rec.dispatch_home, ...env };
      const p = spawn('python3', [ui.rec.cli, 'computer', 'start', app, '--why', why, '--as', 'claude', '--json'], { env: e, cwd: '/tmp' });
      let out = ''; p.stdout.on('data', d => { out += d; }); p.on('close', () => resolve(JSON.parse(out.trim().split('\n').pop() || '{}')));
    });
    // the question window comes up in a few seconds; on a busy Mac it can take a minute
    const scale = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);
    for (const end = Date.now() + 60000 * scale; readState().status !== 'asking' && Date.now() < end; ) await sleep(200);
    if (readState().status !== 'asking') {
      // a locked screen shows no app windows: only the person at that Mac can unlock it (Dispatch says so itself)
      if (/screen is locked/i.test(readState().message || '')) ui.skip(`this Mac's screen is locked, so no app can be used: unlock it (the person at the Mac) and run again. Dispatch said: ${readState().message}`);
      throw new Error(`Dispatch did not ask before ${app}: ${JSON.stringify(readState())}`);
    }
    await sleep(500);
    P('click', readState().pid, 'Allow');
    const st = await started;
    assert.equal(st.status, 'running', JSON.stringify(st));
    await sleep(1500);
    return readState().pid;
  }
  const look = (...a) => (C('look', ...a).text || '');

  // ---- Finder -------------------------------------------------------------------------------------------
  const dir = '/tmp/dcu-e2e-finder';
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'dispatch-test.txt'), 'Dispatch computer-use test file\n');
  results.finderBefore = { front: P('frontmost'), mouse: P('mouse') };
  let pid = await allow('Finder', 'make a test folder in a temporary folder and drag a test file into it');
  results.frontAfterAllow = P('frontmost');
  log('new window', C('menu', T.file, T.newWindow)); await sleep(1500);
  log('go to folder', C('menu', T.go, T.goTo)); await sleep(1500);
  const field = /\[(\d+)\] text field[^\n]*\(focused\)/.exec(look());
  assert.ok(field, 'the Go to Folder box');
  log('fill path', C('fill', field[1], dir));
  log('return', C('press', 'Return')); await sleep(2000);
  results.finderWindow = look().split('\n')[0];
  log('new folder', C('menu', T.file, T.newFolder)); await sleep(1200);
  results.focusedAfterNewFolder = look().split('\n').filter(l => /\(focused\)/.test(l)).slice(0, 3);
  log('type name', C('type', 'Dispatch test folder'));
  log('return', C('press', 'Return')); await sleep(1500);
  results.afterNewFolder = fs.readdirSync(dir);
  assert.ok(results.afterNewFolder.includes('Dispatch test folder'), JSON.stringify(results.afterNewFolder));
  // right after a rename macOS can float its Dictation mark over the folder for a moment: the helper refuses a point on
  // another app and says to look again, which is what a person does
  for (let i = 0; i < 4; i++) {
    const r = log('drag', C('drag', 'dispatch-test.txt', 'Dispatch test folder'));
    if (r.ok || !/That point is on/.test(r.error || r.did || '')) break;
    await sleep(2500);
    look();
  }
  await sleep(2000);
  results.afterDrag = fs.readdirSync(path.join(dir, 'Dispatch test folder'));
  assert.deepEqual(results.afterDrag, ['dispatch-test.txt']);
  const f = /"Dispatch test folder" @(-?\d+),(-?\d+) (\d+)x(\d+)/.exec(look('--frames'));
  assert.ok(f, 'the folder has a place in the window');
  log('double-click point', C('click', `${+f[1] + Math.round(f[3] / 2)},${+f[2] + Math.round(f[4] / 2)}`, '--double')); await sleep(2000);
  results.windowAfterDoubleClick = look().split('\n')[0];
  log('scroll', C('scroll', 'down', '3'));
  results.outside = log('point outside', C('click', '5000,5000'));
  assert.equal(results.outside.ok, false);
  await sleep(2500);
  results.finderAfter = { front: P('frontmost'), mouse: P('mouse') };
  // hover opens the list, away closes it, a click keeps it open
  const bar = P('find', pid, 'Pin steps');
  P('move', bar.x, bar.y); await sleep(600);
  results.hover = (await sock(sockPath, { cmd: 'ping' })).expanded;
  await sock(sockPath, { cmd: 'render', dir: ui.out });
  fs.renameSync(path.join(ui.out, 'steps.png'), path.join(ui.out, '10-finder-steps.png'));
  P('move', 200, 500); await sleep(900);
  results.away = (await sock(sockPath, { cmd: 'ping' })).expanded;
  P('click', pid, 'Pin steps'); P('move', 200, 500); await sleep(900);
  results.pinned = (await sock(sockPath, { cmd: 'ping' })).expanded;
  P('click', pid, 'Unpin steps'); P('move', results.finderBefore.mouse.x, results.finderBefore.mouse.y);
  // Esc on the real keyboard, with Finder in front so the key goes nowhere else
  C('press', 'Up');
  if (/Finder|访达/.test(P('frontmost').name)) P('key', 'esc');
  await sleep(800);
  results.finderEnd = readState();
  assert.equal(results.finderEnd.status, 'stopped');
  assert.equal(results.finderEnd.reason, 'person');
  results.finderPage = results.finderEnd.page;
  await sleep(2000);
  results.finderFinal = { front: P('frontmost'), mouse: P('mouse') };
  // a short second session closes the test window
  pid = await allow('Finder', 'close the test window');
  for (let k = 0; k < 3; k++) {
    const w = look().split('\n')[0];
    if (!/dcu-e2e-finder|Dispatch test folder/.test(w)) break;
    log('close window', C('menu', T.file, T.close)); await sleep(800);
  }
  C('stop');
  fs.rmSync(dir, { recursive: true, force: true });
  await sleep(2000);

  // ---- Notes ------------------------------------------------------------------------------------------
  const mark = `Dispatch test note ${Date.now()}`;
  const notesWasOpen = (() => { try { execFileSync('pgrep', ['-x', 'Notes']); return true; } catch { return false; } })();
  results.notesBefore = { front: P('frontmost'), mouse: P('mouse'), open: notesWasOpen };
  pid = await allow('Notes', 'write a short test note and delete it again');
  log('new note', C('menu', T.file, T.newNote)); await sleep(1500);
  const focused = (look().match(/^.*\(focused\).*$/m) || [''])[0];
  assert.match(focused, /text area \(focused\)$/, 'the keyboard is in an empty new note: ' + focused);
  log('type', C('type', mark));
  log('type', C('type', '\nWritten by Dispatch computer use; deleted right after.'));
  await sleep(800);
  results.noteText = (/text area = "([^"]*)"/.exec(look()) || [])[1];
  assert.ok(results.noteText && results.noteText.startsWith(mark), results.noteText);
  results.notesAfterWriting = { front: P('frontmost'), mouse: P('mouse') };
  log('delete note', C('click', T.del)); await sleep(1200);
  // empty it out of Recently Deleted, only when it is the only note there
  let tree = look();
  if (!new RegExp(T.recently).test(tree)) { log('folders', C('click', T.folders)); await sleep(1200); tree = look(); }
  const rd = new RegExp(`\\[(\\d+)\\] cell "${T.recently}, 1`).exec(tree);
  results.recentlyDeletedOnlyOurs = !!rd;
  if (rd) {
    log('recently deleted', C('click', rd[1])); await sleep(1500);
    const row = new RegExp(`\\[(\\d+)\\] text "${mark}"`).exec(look());
    if (row) {
      log('select note', C('click', row[1])); await sleep(1000);
      if (new RegExp(mark).test((/text area = "([^"]*)"/.exec(look()) || [])[1] || '')) {
        log('delete', C('click', T.del)); await sleep(1200);
        const sheet = look().split('sheet')[1] || '';
        const ok = new RegExp(`\\[(\\d+)\\] button "${T.del}"`).exec(sheet);
        if (ok) { log('confirm', C('click', ok[1])); await sleep(1200); }
      }
    }
  }
  results.noteLeft = new RegExp(mark).test(look());
  assert.equal(results.noteLeft, false, 'the test note is gone');
  await sock(sockPath, { cmd: 'ui', button: 'Pin steps' });
  await sleep(500);
  await sock(sockPath, { cmd: 'render', dir: ui.out });
  fs.renameSync(path.join(ui.out, 'steps.png'), path.join(ui.out, '20-notes-steps.png'));
  results.notesEnd = C('stop');
  results.notesPage = readState().page;
  await sleep(2500);
  results.notesFinal = { front: P('frontmost'), mouse: P('mouse') };
  if (!notesWasOpen) {
    await allow('Notes', 'quit Notes, which was closed before the test');
    log('quit', C('menu', zh ? '备忘录' : 'Notes', zh ? '退出备忘录' : 'Quit Notes'));
    await sleep(2000);
  }
  for (const [name, p] of [['finder', results.finderPage], ['notes', results.notesPage]]) {
    if (p && fs.existsSync(p)) fs.copyFileSync(p, path.join(ui.out, `${name}-page.html`));
  }
  fs.writeFileSync(path.join(ui.out, 'results.json'), JSON.stringify(results, null, 2));
}
