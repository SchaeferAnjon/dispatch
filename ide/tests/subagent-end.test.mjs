import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// When a Claude background sub-agent has ended (task-518qw). On 2026-11-16 three of four background sub-agents of one
// session showed "Working" for six hours: their end came while the parent conversation was idle and the router, which
// maps a message only inside a turn the host started, dropped it (claudeSdkMessageRouter.ts). The fixtures are the
// real lines of that day: the parent's record (prompts and results cut) and the four sub-agents' meta.json.
const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const M = await import(moduleAt('platform/agentHost/node/claude/dispatchSubagentEndModel.ts'));

const fixtures = new URL('./fixtures/subagent-end/', import.meta.url);
const parent = readFileSync(new URL('parent.jsonl', fixtures), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const metas = readdirSync(fixtures).filter(name => name.endsWith('.meta.json')).map(name => readFileSync(new URL(name, fixtures), 'utf8'));

const MAP_TASKS = 'toolu_01UkP4fA8PFimk2JZibUWojY';
const SIDEBAR_ROWS = 'toolu_016C9y1a4R3omUKRnkQZ8sCm';
const QUOTE_BAR = 'toolu_01D7maTEQ45qn3GsuzrQFzpj';
const CHANGES_PAGE = 'toolu_01XMQFJRzbhTnUrJXeDCgTAD';

test('the SDK note with its tool call and an ending status ends the sub-agent', () => {
	assert.deepEqual(M.subagentEndsIn({ type: 'system', subtype: 'task_notification', tool_use_id: QUOTE_BAR, status: 'completed' }), [{ toolUseId: QUOTE_BAR, status: 'completed' }]);
	assert.deepEqual(M.subagentEndsIn({ type: 'system', subtype: 'task_notification', tool_use_id: QUOTE_BAR, status: 'stopped' }).length, 1);
	assert.deepEqual(M.subagentEndsIn({ type: 'system', subtype: 'task_notification', tool_use_id: QUOTE_BAR, status: 'running' }), [], 'not an end');
	assert.deepEqual(M.subagentEndsIn({ type: 'system', subtype: 'task_notification', status: 'completed' }), [], 'a note without its tool call names no sub-agent');
	assert.deepEqual(M.subagentEndsIn({ type: 'system', subtype: 'task_started', tool_use_id: QUOTE_BAR }), []);
	assert.deepEqual(M.subagentEndsIn({ type: 'assistant', message: { content: [] } }), []);
	assert.deepEqual(M.subagentEndsIn(undefined), []);
});

test('replayed: the notes the CLI wrote while the parent was idle name the three that stayed "Working"', () => {
	// these came as a turn the CLI started itself (no turn of the host's): the lines the host used to drop
	const idleNotes = parent.filter(e => e.type === 'user' && typeof e.message.content === 'string');
	const ended = idleNotes.flatMap(e => M.subagentEndsIn(e)).map(end => end.toolUseId);
	assert.deepEqual(ended.sort(), [MAP_TASKS, SIDEBAR_ROWS, QUOTE_BAR].sort());
	for (const e of idleNotes) {
		assert.equal(M.subagentEndsIn(e)[0].status, 'completed');
	}
});

test('replayed: the one that came mid-turn (the one that did end on screen) reads the same, as killed', () => {
	const queued = parent.find(e => e.type === 'attachment');
	const ends = M.subagentEndsIn({ type: 'user', message: { content: queued.attachment.prompt } });
	assert.deepEqual(ends, [{ toolUseId: CHANGES_PAGE, status: 'killed' }]);
});

test('a note in a block list, and two notes in one message, are each read', () => {
	const note = (id, status) => `<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n<summary>Agent "x" finished</summary>\n</task-notification>`;
	assert.deepEqual(M.subagentEndsIn({ type: 'user', message: { content: [{ type: 'text', text: note('toolu_A', 'completed') }] } }).map(e => e.toolUseId), ['toolu_A']);
	assert.deepEqual(M.subagentEndsIn({ type: 'user', message: { content: note('toolu_A', 'completed') + '\n' + note('toolu_B', 'failed') } }).map(e => e.toolUseId), ['toolu_A', 'toolu_B']);
	assert.deepEqual(M.subagentEndsIn({ type: 'user', message: { content: '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>' } }), [{ toolUseId: '', agentId: 'a1', status: 'completed' }], 'a note without a tool call names the agent (the open spawn that ran it ends)');
	assert.deepEqual(M.subagentEndsIn({ type: 'user', message: { content: 'Look at <tool-use-id>toolu_A</tool-use-id>' } }), [], 'words that only quote a tag');
});

test('meta.json: the three that finished say so; the killed one does not, its note ends it', () => {
	assert.deepEqual(M.finishedInMeta(metas).sort(), [MAP_TASKS, SIDEBAR_ROWS, QUOTE_BAR].sort());
	assert.deepEqual(M.finishedInMeta(['{"toolUseId":"toolu_A","finished":true', '', '{"toolUseId":"toolu_B","finished":"yes"}', '{"finished":true}']), [], 'half-written, empty, not true, no tool call');
});

test('the sub-agents folder sits next to the parent record, the folder named as Claude Code names it', () => {
	assert.equal(
		M.subagentFolder('/Users/me/.claude/', '/Users/me/Documents/Projects/dispatch', 'dabf6d55-1631-477c-935d-4157585fdced'),
		'/Users/me/.claude/projects/-Users-me-Documents-Projects-dispatch/dabf6d55-1631-477c-935d-4157585fdced/subagents');
	assert.equal(M.subagentFolder('/c', '/a/b.c_d', 's'), '/c/projects/-a-b-c-d/s/subagents');
});

// Ended without finishing (2026-11-16): killed, stopped and failed show stopped, not done, and one with no word, no
// record written for a long while and no process left never shows Working for ever.
const CHANGES_META = metas.find(t => t.includes(CHANGES_PAGE));
const restart = JSON.parse(readFileSync(new URL('restart-note.json', fixtures), 'utf8'));

test('killed, stopped and failed end it stopped; completed ends it done', () => {
	assert.equal(M.stoppedReason('completed'), undefined);
	assert.match(M.stoppedReason('killed'), /^Stopped/);
	assert.match(M.stoppedReason('stopped'), /^Stopped/);
	assert.match(M.stoppedReason('failed'), /^Failed/);
});

test('replayed: the killed one (Changes panel version history page) never says finished in its meta.json; its note ends it stopped', () => {
	assert.deepEqual(M.metaOf(CHANGES_META), { toolUseId: CHANGES_PAGE, finished: false });
	const queued = parent.find(e => e.type === 'attachment');
	const [end] = M.subagentEndsIn({ type: 'user', message: { content: queued.attachment.prompt } });
	assert.equal(end.toolUseId, CHANGES_PAGE);
	assert.match(M.stoppedReason(end.status), /^Stopped/);
});

test('replayed: the note on a restart names three agents by their ids only, stopped', () => {
	const ends = M.subagentEndsIn({ type: 'user', message: { content: restart.content } });
	assert.deepEqual(ends.map(e => [e.toolUseId, e.agentId, e.status]), [
		['', 'a8e9fcfc8da56b906', 'stopped'], ['', 'af45981fdca3133be', 'stopped'], ['', 'a1cb8477afa9b2017', 'stopped']]);
	// a background shell's note on the same restart names its own tool call: read as that, which is no sub-agent's
	const shell = '<task-notification>\n<task-id>bqpavlfqq</task-id>\n<tool-use-id>toolu_01ADZhzu3Fomn9TWyUxJbKXm</tool-use-id>\n<status>stopped</status>\n</task-notification>';
	assert.deepEqual(M.subagentEndsIn({ type: 'user', message: { content: shell } }).map(e => e.toolUseId), ['toolu_01ADZhzu3Fomn9TWyUxJbKXm']);
});

test('silent: stopped only when its record and its session\'s record are 30 min quiet and no process is left', () => {
	const now = Date.parse('2026-11-16T17:20:00Z');
	const old = now - M.SILENT_MS;
	assert.equal(M.SILENT_MS, 30 * 60_000);
	assert.equal(M.isSilent([old, old], now, false), true, 'quiet for 30 min, no process: stopped');
	assert.equal(M.isSilent([old, old], now, true), false, 'the process is there: it may be waiting on a long build');
	assert.equal(M.isSilent([old, now - 60_000], now, false), false, 'its session wrote a minute ago');
	assert.equal(M.isSilent([now - 29 * 60_000, old], now, false), false, 'it wrote 29 min ago');
	assert.equal(M.isSilent([undefined, old], now, false), true, 'no record of its own yet, the session quiet, no process');
});
