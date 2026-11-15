// The Context reading under the input keeps its last value while a turn runs (kanban, 2026-10-10: "没有必要把数据清掉吧？").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const vs = src ? path.join(src, 'src/vs') : fileURLToPath(new URL('../vscode/src/vs/', import.meta.url));
const { keepLastReading } = await import(pathToFileURL(path.join(vs, 'sessions/contrib/dispatchLife/common/dispatchLifeReading.ts')));

const reading = { percent: 20, context_tokens: 40000, limit_tokens: 200000, cumulative_read_tokens: 900000, status: '', handoff_state: '', rounds: 7 };

test('never read: nothing to show (the meter says Context unavailable)', () => {
	assert.equal(keepLastReading(undefined, undefined), undefined);
	assert.equal(keepLastReading(undefined, { status: '' }).percent, undefined);
});

test('a failed read or one without a reading keeps the last reading', () => {
	assert.equal(keepLastReading(reading, undefined), reading);
	const next = keepLastReading(reading, { status: '', handoff_state: 'saving', rounds: 8 });
	assert.deepEqual([next.percent, next.context_tokens, next.limit_tokens, next.cumulative_read_tokens], [20, 40000, 200000, 900000]);
	assert.equal(next.handoff_state, 'saving', 'the rest is the new read');
	assert.equal(next.rounds, 8);
});

test('a new reading replaces the old one', () => {
	const next = { ...reading, percent: 23, context_tokens: 46000 };
	assert.equal(keepLastReading(reading, next), next);
});
