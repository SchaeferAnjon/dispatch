// A window nobody looks at pauses what only decorates, and wakes the moment somebody does (task: Dispatch eats CPU
// while idle). The OS tells a window it lost focus with a blur event; the runner keeps the Agents window focused
// for its clicks, so the scenario sends that event itself. Checked from the page: the body class, the state of every
// infinite animation, the swarm's frames, then the real mouse, a key and a focus event each waking it.
import assert from 'node:assert/strict';

export const meta = { title: 'Idle window pauses and wakes', description: 'Blur 30 s: infinite animations paused, blocks stop drawing; pointer, key or focus wakes them.', instance: { motion: true }, timeout: 600 };
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE = `(() => {
  const inf = document.getAnimations().filter((a) => a.effect && a.effect.getComputedTiming().iterations === Infinity);
  const water = document.querySelector('.dispatch-swarm canvas');
  return { idle: document.body.classList.contains('dispatch-window-idle'), infinite: inf.length, running: inf.filter((a) => a.playState === 'running').length, paused: inf.filter((a) => a.playState === 'paused').length, hasSwarm: !!water };
})()`;
const frames = (ui) => ui.eval(`new Promise((res) => { let n = 0; const o = window.requestAnimationFrame.bind(window); const t0 = performance.now(); const tick = () => { n++; if (performance.now() - t0 < 1000) o(tick); else res(n); }; o(tick); })`);
// how often the swarm draws: its data-drawn attribute is written only when it changes, so watch the canvas instead
const swarmDraws = (ui) => ui.eval(`new Promise((res) => { const c = document.querySelector('.dispatch-swarm canvas'); if (!c) return res(-1); const ctx = c.getContext('2d'); let n = 0; const orig = ctx.clearRect.bind(ctx); ctx.clearRect = (...a) => { n++; return orig(...a); }; setTimeout(() => { ctx.clearRect = orig; res(n); }, 2000); })`);

export default async function (ui) {
  await ui.openAgents(ui.demoFolder).catch(() => ui.openAgents());
  await ui.waitFor({ css: '.dispatch-status-bar' }, { timeoutMs: 30000 * SCALE });
  await ui.newSession().catch(() => undefined);
  await sleep(8000 * SCALE);
  const out = {};
  out.awake = await ui.eval(STATE);
  out.awakeDraws = await swarmDraws(ui);
  assert.equal(out.awake.idle, false, 'a focused window is not idle');
  assert.ok(out.awake.running >= 1, 'some infinite animation runs while awake: ' + JSON.stringify(out.awake));
  assert.ok(out.awake.hasSwarm, 'the new-session page has its blocks');
  assert.ok(out.awakeDraws > 20, 'the blocks draw while awake: ' + out.awakeDraws + ' frames in 2 s');

  await ui.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined);
  await ui.eval(`window.dispatchEvent(new Event('blur')); true`);
  await sleep(20000 * SCALE);
  out.at20s = await ui.eval(STATE);
  assert.equal(out.at20s.idle, false, 'not idle yet after 20 s');
  await sleep(14000 * SCALE);
  out.idle = await ui.eval(STATE);
  out.idleDraws = await swarmDraws(ui);
  await ui.screenshot('idle');
  assert.equal(out.idle.idle, true, 'idle after 34 s without focus: ' + JSON.stringify(out.idle));
  assert.equal(out.idle.running, 0, 'no infinite animation runs while idle: ' + JSON.stringify(out.idle));
  assert.ok(out.idle.paused >= 1, 'they are paused, not cancelled');
  assert.equal(out.idleDraws, 0, 'the blocks draw nothing while idle');

  // the real mouse over the window wakes it
  await ui.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 300 });
  await sleep(1500);
  out.afterMouse = await ui.eval(STATE);
  out.afterMouseDraws = await swarmDraws(ui);
  assert.equal(out.afterMouse.idle, false, 'the pointer wakes the window');
  assert.ok(out.afterMouse.running >= 1 && out.afterMouse.paused === 0, 'animations run again: ' + JSON.stringify(out.afterMouse));
  assert.ok(out.afterMouseDraws > 20, 'the blocks swim again: ' + out.afterMouseDraws);

  // idle again, then a key
  await sleep(33000 * SCALE);
  assert.equal((await ui.eval(STATE)).idle, true, 'idle again');
  await ui.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
  await ui.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
  await sleep(1200);
  out.afterKey = await ui.eval(STATE);
  assert.equal(out.afterKey.idle, false, 'a key wakes the window');

  // idle again, then the window gets focus back
  await sleep(33000 * SCALE);
  assert.equal((await ui.eval(STATE)).idle, true, 'idle a third time');
  await ui.eval(`window.dispatchEvent(new Event('focus')); true`);
  await sleep(1200);
  out.afterFocus = await ui.eval(STATE);
  assert.equal(out.afterFocus.idle, false, 'focus wakes the window');
  await ui.screenshot('awake');
  console.log('IDLE-WAKE ' + JSON.stringify(out));
}
