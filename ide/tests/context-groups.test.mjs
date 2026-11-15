import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const m = await import(moduleAt('sessions/contrib/dispatchLife/common/dispatchContextGroups.ts'));

// what Claude Code's getContextUsage answered for a real session, rounded
const usage = {
	total: 92000, max: 200000, categories: [
		{ name: 'System prompt', tokens: 3000 }, { name: 'System tools', tokens: 14000 },
		{ name: 'MCP tools', tokens: 9000 }, { name: 'MCP tools (deferred)', tokens: 30000, deferred: true },
		{ name: 'Memory files', tokens: 6000 }, { name: 'Skills', tokens: 4000 }, { name: 'Messages', tokens: 56000 },
		{ name: 'Free space', tokens: 75000 }, { name: 'Autocompact buffer', tokens: 33000 },
	],
};

test('the rows go into the four groups the person asked about, plus free and kept back', () => {
	const g = m.contextGroups(usage);
	assert.deepEqual(g.map(x => [x.key, x.tokens, x.percent]), [
		['system', 23000, 11.5], ['mcp', 9000, 4.5], ['skills', 4000, 2], ['conversation', 56000, 28], ['free', 75000, 37.5], ['reserved', 33000, 16.5],
	]);
	assert.deepEqual(g[0].parts.map(p => p.name), ['System prompt', 'System tools', 'Memory files']);
});

test('deferred tool schemas are not in the window and are left out', () => {
	assert.ok(!m.contextGroups(usage).some(x => x.parts.some(p => /deferred/.test(p.name))));
});

test('the grid has 100 squares, in proportion, every group at least one', () => {
	const grid = m.contextGrid(m.contextGroups(usage));
	assert.equal(grid.length, 100);
	const count = k => grid.filter(x => x === k).length;
	assert.equal(count('conversation'), 28);
	assert.equal(count('skills'), 2);
	const tiny = m.contextGrid(m.contextGroups({ max: 1000, categories: [{ name: 'Messages', tokens: 999 }, { name: 'Skills', tokens: 1 }] }));
	assert.equal(tiny.filter(x => x === 'skills').length, 1);
	assert.equal(tiny.length, 100);
});

test('no breakdown (another engine, or before the first turn): nothing to draw', () => {
	assert.equal(m.contextGroups(undefined), undefined);
	assert.equal(m.contextGroups({ max: 0, categories: [] }), undefined);
});
