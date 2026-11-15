import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const m = await import(moduleAt('workbench/contrib/dispatchMotion/browser/dispatchIdleModel.ts'));

/** A clock the test moves by hand; timers fire when it passes them. */
function clock() {
 let t = 1000;
 let next = 1;
 const timers = new Map();
 return {
  now: () => t,
  setTimeout: (fn, ms) => { const h = next++; timers.set(h, { at: t + ms, fn }); return h; },
  clearTimeout: h => timers.delete(h),
  advance(ms) {
   const end = t + ms;
   for (;;) {
    const due = [...timers].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    timers.delete(due[0]);
    t = Math.max(t, due[1].at);
    due[1].fn();
   }
   t = end;
  },
  pending: () => timers.size,
 };
}

function tracker(start) {
 const c = clock();
 const changes = [];
 const tr = new m.DispatchIdleTracker(c, idle => changes.push(idle), start);
 return { c, tr, changes };
}

test('a focused window is never idle, however long it sits', () => {
 const { c, tr, changes } = tracker();
 c.advance(10 * 60_000);
 assert.equal(tr.idle, false);
 assert.deepEqual(changes, []);
});

test('an unfocused window goes idle after 30 s and wakes on focus', () => {
 const { c, tr, changes } = tracker();
 tr.setFocused(false);
 c.advance(29_000);
 assert.equal(tr.idle, false);
 c.advance(2_000);
 assert.equal(tr.idle, true);
 tr.setFocused(true);
 assert.equal(tr.idle, false);
 assert.deepEqual(changes, [true, false]);
 assert.equal(c.pending(), 0, 'no timer left once focused');
});

test('the pointer over an unfocused window keeps it awake, and wakes it when idle', () => {
 const { c, tr, changes } = tracker();
 tr.setFocused(false);
 c.advance(20_000);
 tr.interact();
 c.advance(20_000);
 assert.equal(tr.idle, false, '20 s after the last pointer move');
 c.advance(11_000);
 assert.equal(tr.idle, true);
 tr.interact();
 assert.equal(tr.idle, false);
 c.advance(31_000);
 assert.equal(tr.idle, true);
 assert.deepEqual(changes, [true, false, true]);
});

test('a hidden window is idle at once, even focused, and wakes when shown', () => {
 const { c, tr, changes } = tracker();
 tr.setVisible(false);
 assert.equal(tr.idle, true);
 tr.interact();
 c.advance(5_000);
 assert.equal(tr.idle, true, 'touching a hidden window changes nothing');
 tr.setVisible(true);
 assert.equal(tr.idle, false);
 assert.deepEqual(changes, [true, false]);
});

test('a window that starts unfocused is idle only after the 30 s', () => {
 const { c, tr } = tracker({ focused: false, visible: true });
 assert.equal(tr.idle, false);
 c.advance(30_001);
 assert.equal(tr.idle, true);
});

test('a window that starts hidden is idle from the start', () => {
 const changes = [];
 const tr = new m.DispatchIdleTracker(clock(), idle => changes.push(idle), { focused: true, visible: false });
 assert.equal(tr.idle, true);
 assert.deepEqual(changes, [true]);
});

test('dispose leaves no timer', () => {
 const { c, tr } = tracker();
 tr.setFocused(false);
 assert.equal(c.pending(), 1);
 tr.dispose();
 assert.equal(c.pending(), 0);
});

test('a throttle runs the first call at once and folds the rest of the gap into one run at its end', () => {
 const c = clock();
 let runs = 0;
 const th = m.throttleLeadingTrailing(c, () => runs++, 5000);
 th.call();
 assert.equal(runs, 1);
 for (let i = 0; i < 10; i++) { c.advance(300); th.call(); }
 assert.equal(runs, 1, 'still inside the gap');
 c.advance(2100);
 assert.equal(runs, 2, 'one run at the end of the gap, not ten');
 c.advance(20_000);
 assert.equal(runs, 2);
 th.call();
 assert.equal(runs, 3, 'after a quiet gap the next call is at once');
});

test('a cancelled throttle does not run', () => {
 const c = clock();
 let runs = 0;
 const th = m.throttleLeadingTrailing(c, () => runs++, 1000);
 th.call();
 th.call();
 th.cancel();
 c.advance(5000);
 assert.equal(runs, 1);
});
