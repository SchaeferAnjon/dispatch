// OpenCode's sessions in the agent host's index (opencodeSessionIndex.ts, kanban task-mpidn): a listing never
// waits for OpenCode, an unknown id is never looked up on its own, and never more than one `opencode db` runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const { OpenCodeSessionIndex, openCodeDatabaseSignature } = await import(moduleAt('platform/agentHost/node/opencode/opencodeSessionIndex.ts'));

const row = (n, extra = {}) => ({ id: `ses_${String(n).padStart(12, 'a')}`, directory: '/p', created: n, updated: n, listed: true, ...extra });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function setup({ rows = [row(1), row(2)], direct = true, cliDelay = 20 } = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), 'oc-index-'));
	const database = path.join(dir, 'opencode.db');
	writeFileSync(database, 'x');
	const calls = { database: 0, cli: 0, cliNow: 0, cliMost: 0, since: [] };
	const state = { rows, direct, failCli: false };
	const reader = {
		databasePath: async () => database,
		readDatabase: async (_database, since) => {
			calls.database++;
			calls.since.push(since);
			await sleep(5);
			if (!state.direct) {
				throw new Error('SQLITE_CANTOPEN');
			}
			return since === undefined ? state.rows : state.rows.filter(r => r.updated >= since);
		},
		readCli: async () => {
			calls.cli++;
			calls.cliNow++;
			calls.cliMost = Math.max(calls.cliMost, calls.cliNow);
			await sleep(cliDelay);
			calls.cliNow--;
			if (state.failCli) {
				throw new Error('Command failed: opencode db');
			}
			return state.rows;
		},
	};
	const logs = [];
	const make = (options = {}) => new OpenCodeSessionIndex(reader, { cacheFile: path.join(dir, 'index.json'), log: (level, message) => logs.push(`${level} ${message}`), checkEveryMs: 0, readGapMs: 0, cliGapMs: 0, ...options });
	const touch = () => {
		writeFileSync(database, `x${Math.random()}`);
		const t = new Date(Date.now() + Math.floor(Math.random() * 1e6));
		utimesSync(database, t, t);
	};
	return { dir, database, calls, state, make, touch, logs };
}

test('200 ids OpenCode does not have: null at once, from one read of the whole index, no `opencode db`', async () => {
	const { calls, make } = setup();
	const index = make();
	await index.loaded;
	const ids = Array.from({ length: 200 }, (_, i) => `ses_missing${String(i).padStart(6, '0')}`);
	for (let round = 0; round < 5; round++) {
		for (const id of ids) {
			index.check();
			assert.equal(index.get(id), null);
		}
	}
	await sleep(30);
	assert.equal(calls.database, 1);
	assert.equal(calls.cli, 0);
	assert.equal(index.get(row(1).id).id, row(1).id);
	index.dispose();
});

test('the index from disk answers at once after a restart; nothing is read while the database is unchanged', async () => {
	const { calls, make, dir } = setup();
	const first = make();
	await first.loaded;
	first.dispose();
	assert.ok(existsSync(path.join(dir, 'index.json')));
	const second = make();
	await second.loaded;
	assert.equal(second.source, 'cache');
	assert.equal(second.get(row(2).id).id, row(2).id);
	for (let i = 0; i < 50; i++) {
		second.check();
	}
	await sleep(30);
	assert.equal(calls.database, 1, 'only the first start read the database');
	second.dispose();
});

test('a change to the database is read once in the background; a new session is found then', async () => {
	const { calls, make, touch, state } = setup();
	const index = make();
	await index.loaded;
	const reads = [];
	index.onDidRead(rows => reads.push(rows.length));
	state.rows = [row(1), row(2), row(3)];
	touch();
	for (let i = 0; i < 20; i++) {
		index.check();
	}
	assert.equal(index.get(row(3).id), null, 'the read is in the background, the answer is the index as it is');
	await sleep(40);
	assert.equal(calls.database, 2);
	assert.equal(index.get(row(3).id).id, row(3).id);
	assert.deepEqual(reads, [3]);
	index.dispose();
});

test('the database cannot be read directly: one `opencode db` at a time, however many ask', async () => {
	const { calls, make, touch } = setup({ direct: false, cliDelay: 30 });
	const index = make();
	await index.loaded;
	assert.equal(index.source, 'cli');
	await Promise.all(Array.from({ length: 40 }, () => index.refresh()));
	touch();
	for (let i = 0; i < 40; i++) {
		index.check();
	}
	await sleep(120);
	assert.equal(calls.cliMost, 1, 'never two `opencode db` at once');
	assert.ok(calls.cli <= 4, `${calls.cli} reads for 80 asks`);
	index.dispose();
});

test('a failed read is not tried again until the database changes; the last index stays', async () => {
	const { calls, make, state, touch } = setup({ direct: false });
	const index = make();
	await index.loaded;
	state.failCli = true;
	touch();
	index.check();
	await sleep(40);
	const after = calls.cli;
	for (let i = 0; i < 30; i++) {
		index.check();
	}
	await sleep(40);
	assert.equal(calls.cli, after, 'no retry storm while nothing changed');
	assert.equal(index.get(row(1).id).id, row(1).id, 'the rows read before stay');
	index.dispose();
});

test('never read at all (no database, `opencode db` fails): undefined, the host keeps its own row', async () => {
	const { make, state } = setup({ direct: false });
	state.failCli = true;
	const index = make({ cacheFile: undefined });
	await index.loaded;
	assert.equal(index.get(row(1).id), undefined);
	index.dispose();
});

test('the read gap: a database written every moment is read at most once per gap', async () => {
	const { calls, make, touch } = setup();
	const index = make({ readGapMs: 100 });
	await index.loaded;
	for (let i = 0; i < 10; i++) {
		touch();
		index.check();
		await sleep(10);
	}
	await sleep(150);
	assert.ok(calls.database <= 3, `${calls.database} reads in about 250 ms`);
	index.dispose();
});

test('the signature changes with the database and its write-ahead log', async () => {
	const { database } = setup();
	const before = await openCodeDatabaseSignature(database);
	writeFileSync(`${database}-wal`, 'wal');
	assert.notEqual(await openCodeDatabaseSignature(database), before);
	assert.equal(await openCodeDatabaseSignature(undefined), 'none');
});

test('after a full read only the sessions updated since are read; everything again once the full-read time is up', async () => {
	const { calls, make, touch, state } = setup({ rows: [row(1000), row(2000)] });
	const index = make({ fullEveryMs: 60_000 });
	await index.loaded;
	assert.deepEqual(calls.since, [undefined]);
	state.rows = [row(1000), row(2000), row(5000)];
	touch();
	index.check();
	await sleep(40);
	assert.equal(calls.since[1], 1000, 'the newest known update less a second');
	assert.equal(index.get(row(5000).id).id, row(5000).id);
	assert.equal(index.rows.length, 3, 'merged into the index, nothing dropped');
	assert.equal(index.fullReads, 1);
	index.dispose();

	// the full-read time up: a deleted session leaves the index
	const again = make({ fullEveryMs: 0 });
	await again.loaded;
	state.rows = [row(1000)];
	touch();
	again.check();
	await sleep(40);
	assert.equal(calls.since.at(-1), undefined);
	assert.equal(again.get(row(2000).id), null);
	again.dispose();
});
