import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const model = await import(moduleAt('sessions/contrib/dispatchTours/browser/dispatchToursModel.ts'));

const overlaps = (a, b) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

test('a tip never covers a kept-clear box beside its element (task-5k8a)', () => {
	// the first tip points at Waiting for you in the left column; the Assistant's tabs sit just right of it
	const waiting = { left: 8, top: 112, width: 264, height: 64 };
	const tabs = { left: 296, top: 72, width: 180, height: 32 };
	const size = { width: 320, height: 151 };
	const viewport = { width: 1440, height: 884 };
	const before = model.placeBubble(waiting, size, viewport, 'right');
	assert.ok(overlaps({ left: before.left, top: before.top, ...size }, tabs), 'without keep-clear the tip covers the tabs (the bug)');
	const at = model.placeBubble(waiting, size, viewport, 'right', [tabs]);
	assert.equal(at.side, 'right');
	assert.ok(!overlaps({ left: at.left, top: at.top, ...size }, tabs), JSON.stringify(at));
	// the arrow still points into the element it is about
	const arrowY = at.top + at.arrowOffset;
	assert.ok(arrowY >= waiting.top && arrowY <= waiting.top + waiting.height, `arrow at ${arrowY}`);
	assert.ok(model.KEEP_CLEAR.includes('.sessions-chat-session-type-picker'));
});

test('the Ask in plain words tip does not cover the notice above the input (kanban task-6vw2)', () => {
	// the new-session page of a new Mac, 1024 wide (the VM): the input, and the No agent notice with Install above it
	const input = { left: 308, top: 296, width: 688, height: 66 };
	const notice = { left: 308, top: 226, width: 688, height: 70 };
	const size = { width: 320, height: 152 };
	const viewport = { width: 1024, height: 684 };
	const before = model.placeBubble(input, size, viewport, 'top');
	assert.ok(overlaps({ left: before.left, top: before.top, ...size }, notice), 'without keep-clear the tip covers Install (the bug)');
	const at = model.placeBubble(input, size, viewport, 'top', [notice]);
	assert.ok(!overlaps({ left: at.left, top: at.top, ...size }, notice), JSON.stringify(at));
	assert.ok(model.KEEP_CLEAR.includes('.chat-input-notification-widget'));
});

test('when sliding cannot keep the arrow on the element, another side is used', () => {
	const small = { left: 8, top: 80, width: 600, height: 20 };
	const tabs = { left: 620, top: 0, width: 300, height: 884 };
	const at = model.placeBubble(small, { width: 320, height: 151 }, { width: 1440, height: 884 }, 'right', [tabs]);
	assert.notEqual(at.side, 'right');
	assert.ok(!overlaps({ left: at.left, top: at.top, width: 320, height: 151 }, tabs), JSON.stringify(at));
});

test('nothing to keep clear: the same place as before', () => {
	const t = { left: 400, top: 100, width: 80, height: 30 };
	assert.deepEqual(model.placeBubble(t, { width: 320, height: 120 }, { width: 1200, height: 800 }, 'bottom', []),
		model.placeBubble(t, { width: 320, height: 120 }, { width: 1200, height: 800 }, 'bottom'));
});

test('the Start here tip slides off the agent picker beside its card', () => {
	// CSS px of the new-session page at 1440 wide: the suggestion card, and the agent picker just above it
	const card = { left: 466, top: 369, width: 240, height: 64 };
	const picker = { left: 607, top: 293, width: 150, height: 32 };
	const size = { width: 320, height: 151 };
	const viewport = { width: 1440, height: 884 };
	const at = model.placeBubble(card, size, viewport, 'top', [picker]);
	assert.ok(!overlaps({ left: at.left, top: at.top, ...size }, picker), JSON.stringify(at));
	const arrowX = at.left + at.arrowOffset;
	if (at.side === 'top' || at.side === 'bottom') assert.ok(arrowX >= card.left && arrowX <= card.left + card.width, `arrow at ${arrowX}`);
});

test('the Getting started tip on the bottom bar does not sit on a session\'s message box (kanban task-lj06.21)', () => {
	// CSS px of the report's screenshot at 1440 x 900: the bottom bar's Getting started entry at the left, the
	// session's message box (with the agent chip at its left end) just above the bar
	const entry = { left: 8, top: 878, width: 150, height: 20 };
	const box = { left: 300, top: 760, width: 700, height: 110 };
	const size = { width: 320, height: 140 };
	const viewport = { width: 1440, height: 900 };
	const before = model.placeBubble(entry, size, viewport, 'bottom', []);
	assert.ok(overlaps({ left: before.left, top: before.top, ...size }, box), 'without the box kept clear the tip sits on it (the bug)');
	const at = model.placeBubble(entry, size, viewport, 'bottom', [box]);
	assert.notEqual(at.side, 'none');
	assert.ok(!overlaps({ left: at.left, top: at.top, ...size }, box), JSON.stringify(at));
	assert.ok(model.KEEP_CLEAR.includes('.interactive-input-part'), 'a session\'s whole message box is kept clear');
	for (const sel of ['.new-chat-input-container', '.new-chat-input-area', '.new-chat-bottom-container']) {
		assert.ok(model.KEEP_CLEAR.includes(sel), `${sel} is kept clear`);
	}
});

test('a tip about a part of the message box points at the box from outside it', () => {
	const box = { left: 300, top: 600, width: 700, height: 160 };
	const chips = { left: 316, top: 720, width: 300, height: 28 };
	const size = { width: 320, height: 140 };
	const at = model.placeBubble(chips, size, { width: 1440, height: 900 }, 'top', [box]);
	assert.equal(at.side, 'top');
	assert.ok(at.top + size.height <= box.top, JSON.stringify(at));
});

test('no window size or layout puts a tip on a kept-clear control', () => {
	// the rule as a property: random windows, elements, bubbles and controls; the bubble is either clear of every
	// control or not shown at all (side none)
	let seed = 7;
	const rnd = (lo, hi) => { seed = (seed * 1103515245 + 12345) % 2147483648; return lo + (seed / 2147483648) * (hi - lo); };
	let none = 0;
	for (let i = 0; i < 4000; i++) {
		const viewport = { width: Math.round(rnd(500, 1800)), height: Math.round(rnd(400, 1100)) };
		const size = { width: Math.round(rnd(200, 340)), height: Math.round(rnd(90, 220)) };
		const box = () => {
			const w = rnd(20, viewport.width * 0.8), h = rnd(16, viewport.height * 0.4);
			return { left: rnd(0, viewport.width - w), top: rnd(0, viewport.height - h), width: w, height: h };
		};
		const keep = Array.from({ length: Math.floor(rnd(0, 4)) }, box);
		const target = box();
		const side = ['top', 'right', 'bottom', 'left'][Math.floor(rnd(0, 4))];
		const at = model.placeBubble(target, size, viewport, side, keep);
		if (at.side === 'none') { none++; continue; }
		for (const k of keep) {
			assert.ok(!overlaps({ left: at.left, top: at.top, ...size }, k), JSON.stringify({ viewport, size, target, keep, side, at }));
		}
	}
	assert.ok(none < 400, `${none} of 4000 had no room at all`);
});
