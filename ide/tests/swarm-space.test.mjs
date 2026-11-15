import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const m = await import(moduleAt('sessions/contrib/aquarium/browser/dispatchSwarmSpace.ts'));

// the close button at the top left of the new-session page (aquarium.css: 7px in, 24px) and a line of text
const CLOSE = { l: 7, t: 7, r: 31, b: 31 };
const TEXT = { l: 200, t: 300, r: 600, b: 320 };

function seeded(seed) {
	let x = seed;
	return () => (x = (x * 16807) % 2147483647) / 2147483647;
}

test('a block on the close button is a hit, one well clear of it is not (0.9.2: the blocks sat on the ✕)', () => {
	assert.ok(m.swarmHit(18, 18, 20, [CLOSE]));
	assert.equal(m.swarmHit(120, 120, 20, [CLOSE]), undefined);
	// the gap counts: a 20px block whose edge is 2px from the button still covers it
	assert.ok(m.swarmHit(31 + 10 + 2, 18, 20, [CLOSE]));
});

test('a free spot never touches a kept-out rectangle', () => {
	const rand = seeded(7);
	for (let i = 0; i < 500; i++) {
		const s = 14 + rand() * 16;
		const spot = m.swarmFreeSpot(s, 800, 600, [CLOSE, TEXT], rand);
		assert.ok(spot, 'an 800 × 600 page has room');
		assert.equal(m.swarmHit(spot.x, spot.y, s, [CLOSE, TEXT]), undefined);
	}
});

test('a page with no room gives no spot (the block waits out of sight)', () => {
	assert.equal(m.swarmFreeSpot(20, 800, 600, [{ l: 0, t: 0, r: 800, b: 600 }], seeded(3)), undefined);
	assert.equal(m.swarmFreeSpot(20, 0, 0, [], seeded(3)), undefined, 'a hidden page (0 × 0)');
});

test('a block that swims into text is pushed back out the short way, its velocity turned away', () => {
	const b = { x: 210, y: 296, s: 20, vx: 0.2, vy: 0.4 };	// just above the line, moving down into it
	const deep = m.swarmPushOut(b, [TEXT]);
	assert.ok(deep > 0 && deep < 20);
	assert.equal(m.swarmHit(b.x, b.y, b.s, [TEXT]), undefined);
	assert.ok(b.vy < 0, 'it moves up now');
});

test('a block deep inside something reports a deep push, so the swarm moves it elsewhere', () => {
	const b = { x: 400, y: 310, s: 20, vx: 0, vy: 0 };
	assert.ok(m.swarmPushOut(b, [TEXT]) > 12);
});

test('a size change keeps each block at its share of the page; from 0 × 0 nothing moves', () => {
	const bodies = [{ x: 100, y: 50, s: 20, vx: 0, vy: 0 }];
	m.swarmRescale(bodies, 400, 200, 800, 600);
	assert.deepEqual([bodies[0].x, bodies[0].y], [200, 150]);
	m.swarmRescale(bodies, 0, 0, 800, 600);
	assert.deepEqual([bodies[0].x, bodies[0].y], [200, 150]);
});

test('the icon place is free only when it covers nothing', () => {
	assert.equal(m.swarmRectFree(300, 100, 420, 190, [CLOSE, TEXT]), true);
	assert.equal(m.swarmRectFree(300, 250, 420, 310, [CLOSE, TEXT]), false);
});
