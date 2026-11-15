// Claude Code's session list in the agent host (claudeSessionListCache.ts, kanban task-mpidn): read again only when a
// project folder changed or the list is old; callers meanwhile share one read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const { ClaudeSessionListCache, claudeProjectsSignature } = await import(moduleAt('platform/agentHost/node/claude/claudeSessionListCache.ts'));

function setup() {
	const projects = path.join(mkdtempSync(path.join(tmpdir(), 'claude-list-')), 'projects');
	mkdirSync(path.join(projects, '-Users-me-app'), { recursive: true });
	let reads = 0;
	let clock = 1000;
	const cache = new ClaudeSessionListCache(() => projects, async () => { reads++; await new Promise(r => setTimeout(r, 10)); return [`list ${reads}`]; }, 60_000, () => clock);
	return { projects, cache, reads: () => reads, tick: ms => clock += ms };
}

test('one read while the folders stay the same; twenty callers at once share it', async () => {
	const { cache, reads } = setup();
	const answers = await Promise.all(Array.from({ length: 20 }, () => cache.get()));
	assert.equal(reads(), 1);
	assert.deepEqual(answers[19], ['list 1']);
	assert.deepEqual(await cache.get(), ['list 1']);
	assert.equal(reads(), 1);
});

test('a new session (a file in a project folder) or a new project folder reads again', async () => {
	const { projects, cache, reads } = setup();
	await cache.get();
	const folder = path.join(projects, '-Users-me-app');
	writeFileSync(path.join(folder, 'new.jsonl'), '{}\n');
	const later = new Date(Date.now() + 5000);
	utimesSync(folder, later, later);
	await cache.get();
	assert.equal(reads(), 2);
	mkdirSync(path.join(projects, '-Users-me-other'));
	await cache.get();
	assert.equal(reads(), 3);
});

test('read again after the longest age, and after clear()', async () => {
	const { cache, reads, tick } = setup();
	await cache.get();
	tick(61_000);
	await cache.get();
	assert.equal(reads(), 2);
	cache.clear();
	await cache.get();
	assert.equal(reads(), 3);
});

test('no projects folder yet: a signature all the same, and the list is read', async () => {
	assert.equal(await claudeProjectsSignature(path.join(tmpdir(), 'no-such-claude-folder', 'projects')), 'none');
});
