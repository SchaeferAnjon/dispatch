import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const { dispatchColumnsFor } = await import(moduleAt('sessions/browser/dispatchColumns.ts'));

const min = { sidebar: 170, chat: 296, pane: 300 };

test('a window made narrow and wide again comes back to the columns the person had (task-m9k4w)', () => {
	// a file in the side pane (its share of the room), and Changes or Files (its width)
	for (const anchor of [{ sidebar: 170, chat: 620, pane: 640, shared: true }, { sidebar: 280, chat: 812, pane: 340, shared: false }]) {
		const total = anchor.sidebar + anchor.chat + anchor.pane;
		for (const narrow of [790, 900, 1100]) {
			const squeezed = dispatchColumnsFor(anchor, narrow, min);
			assert.equal(squeezed.sidebar + squeezed.chat + squeezed.pane, narrow);
			assert.ok(squeezed.chat >= min.chat && squeezed.pane >= min.pane && squeezed.sidebar >= min.sidebar, JSON.stringify(squeezed));
			// each step is laid out from the person's widths, not from the squeezed ones
			assert.deepEqual(dispatchColumnsFor(anchor, total, min), anchor);
		}
	}
});

test('the side bar keeps its width until the other two are at their smallest', () => {
	const anchor = { sidebar: 280, chat: 812, pane: 340, shared: false };
	assert.deepEqual(dispatchColumnsFor(anchor, 1100, min), { sidebar: 280, chat: 480, pane: 340, shared: false });
	// the conversation goes down to its smallest first, then the side pane, then the side bar
	assert.deepEqual(dispatchColumnsFor(anchor, 900, min), { sidebar: 280, chat: 296, pane: 324, shared: false });
	assert.deepEqual(dispatchColumnsFor(anchor, 790, min), { sidebar: 194, chat: 296, pane: 300, shared: false });
});

test('a file in the side pane keeps its share; a wider window than before grows the conversation', () => {
	const shared = { sidebar: 200, chat: 600, pane: 600, shared: true };
	assert.deepEqual(dispatchColumnsFor(shared, 1000, min), { sidebar: 200, chat: 400, pane: 400, shared: true });
	assert.deepEqual(dispatchColumnsFor(shared, 1800, min), { sidebar: 200, chat: 800, pane: 800, shared: true });
	const fixed = { sidebar: 200, chat: 600, pane: 400, shared: false };
	assert.deepEqual(dispatchColumnsFor(fixed, 1800, min), { sidebar: 200, chat: 1200, pane: 400, shared: false });
	// no side pane, no side bar
	assert.deepEqual(dispatchColumnsFor({ sidebar: 0, chat: 900, pane: 0, shared: false }, 700, min), { sidebar: 0, chat: 700, pane: 0, shared: false });
});
