import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const m = await import(moduleAt('sessions/contrib/dispatchAttribution/browser/dispatchAttributionStepsModel.ts'));

const T = 1_800_000_000;
const answer = (over = {}) => ({
	ok: true, root: '/p',
	turns: [
		{ n: 1, agent: 'OpenCode', engine: 'opencode', start: T, end: T + 40, text: 'add', added: 4, removed: 0, commits: [],
			files: [{ rel: 'NOTES.md', path: '/p/NOTES.md', before: '/v/a/NOTES.md', after: '/v/b/NOTES.md', added: 4, removed: 0 }] },
		{ n: 2, agent: 'OpenCode', engine: 'opencode', start: T + 300, end: T + 330, text: 'commit', added: 0, removed: 0, files: [],
			commits: [{ hash: 'abcdef1234', short: 'abcdef1', subject: 'Add notes', message: 'Add notes', ts: T + 320, yours: 2, agent: 'OpenCode' }] },
	],
	yours: [{ after_turn: 1, anchor: T + 40, until: T + 300, ts: T + 120, last: T + 130, count: 2, agent: 'OpenCode', told: 'OpenCode', next_turn: 2,
		files: [{ rel: 'NOTES.md', path: '/p/NOTES.md', before: '/v/b/NOTES.md', after: '/v/c/NOTES.md', lines: '5, 8', count: 2, first: 5 }] }],
	...over,
});

test('the answer is read, and anything else is not', () => {
	const s = m.parseSteps(answer());
	assert.equal(s.turns.length, 2);
	assert.equal(s.turns[1].commits[0].yours, 2);
	assert.equal(s.yours[0].files[0].first, 5);
	assert.equal(m.parseSteps({ ok: false }), undefined);
	assert.equal(m.parseSteps(null), undefined);
	assert.deepEqual(m.parseSteps(answer({ yours: [{ anchor: 1, files: [] }] })).yours, []);
});

test('the chat row says how many lines and where, and what the agent hears', () => {
	const y = m.parseSteps(answer()).yours[0];
	assert.equal(m.yoursLabel(y), 'You changed 2 lines in NOTES.md');
	assert.equal(m.yoursLabel({ ...y, count: 1 }), 'You changed 1 line in NOTES.md');
	assert.equal(m.yoursLabel({ ...y, count: 5, files: [y.files[0], { ...y.files[0], rel: 'a/b.py' }] }), 'You changed 5 lines in 2 files');
	assert.match(m.yoursTip(y), /^OpenCode was told about these lines when turn 2 started/);
	assert.match(m.yoursTip({ ...y, told: '', until: undefined }), /^OpenCode hears about these lines when its next turn starts/);
	assert.match(m.yoursTip({ ...y, told: '' }), /^Turn 2 started without the note/);
});

test('the commit card counts your lines only when there are some', () => {
	assert.equal(m.commitYoursLabel(2), 'Includes 2 lines you changed');
	assert.equal(m.commitYoursLabel(1), 'Includes 1 line you changed');
	assert.equal(m.commitYoursLabel(0), '');
	assert.ok(m.hasCoAuthor('Add\n\nCo-authored-by: OpenCode <noreply@opencode.ai>'));
	assert.ok(!m.hasCoAuthor('Add notes'));
});

test('your lines on their own in Changes: their changeset, its name and files', () => {
	const s = m.parseSteps(answer());
	assert.equal(m.stepOfChangeset(m.changesetId('you:1')), 'you:1');
	assert.equal(m.stepOfChangeset('branch'), undefined);
	assert.equal(m.stepOfChangeset('dispatch-attr:turn:1'), undefined);
	assert.equal(m.stepNote(s, 'you:1').title, 'Your changes');
	assert.match(m.stepNote(s, 'you:1').rest, /^2 lines · after turn 1 · .+$/);
	assert.equal(m.stepNote(s, 'you:9'), undefined);
	assert.equal(m.stepFiles(s, 'you:1')[0].after, '/v/c/NOTES.md');
	assert.deepEqual(m.stepFiles(s, 'you:9'), []);
});

test('a row goes under the reply whose request came last before it', () => {
	const req = [{ id: 'r1', ts: T * 1000 }, { id: 'r2', ts: (T + 300) * 1000 }];
	assert.equal(m.replyFor(req, T + 40), 'r1');
	assert.equal(m.replyFor(req, T + 330), 'r2');
	assert.equal(m.replyFor(req, T + 297), 'r1');
	assert.equal(m.replyFor(req, T - 100), undefined);
	assert.equal(m.replyFor(req, T - 1), 'r1'); // a mark a moment before the request was stored
});

test('a commit you made yourself is read as yours, with whose lines it holds', () => {
	const own = { hash: 'fedcba9876', short: 'fedcba9', subject: 'By hand', message: 'By hand', ts: T + 200, yours: 2, by: 'you', message_by: 'OpenCode', agents: [{ agent: 'OpenCode', lines: 4 }, { agent: '', lines: 3 }] };
	const s = m.parseSteps(answer({ turns: [{ ...answer().turns[0], own_commits: [own, { short: 'x' }] }, answer().turns[1]] }));
	const c = s.turns[0].own_commits;
	assert.equal(c.length, 1);
	assert.equal(c[0].by, 'you');
	assert.equal(c[0].message_by, 'OpenCode');
	assert.deepEqual(c[0].agents, [{ agent: 'OpenCode', lines: 4 }]);
	assert.equal(m.ownCommitLabel(c[0]), 'Holds 4 lines OpenCode wrote · 2 lines you changed');
	assert.equal(m.ownCommitLabel({ ...c[0], agents: [], yours: 1 }), 'Holds 1 line you changed');
	assert.equal(m.ownCommitLabel({ ...c[0], agents: [], yours: 0 }), '');
	assert.deepEqual(s.turns[1].own_commits, []);
});

test('a Turbo run brought in after a turn is its agent\'s, not yours (task-v6glz)', () => {
	const turbo = { hash: 'aa11bb22cc', short: 'aa11bb2', subject: 'Turbo: Footer and blue Add button', message: 'Turbo: Footer and blue Add button', ts: T + 250, yours: 0, by: 'turbo', maker: 'OpenCode', engine: 'opencode', message_by: 'OpenCode', agents: [{ agent: 'OpenCode', lines: 13 }] };
	const s = m.parseSteps(answer({ turns: [{ ...answer().turns[0], own_commits: [turbo] }, answer().turns[1]] }));
	const c = s.turns[0].own_commits[0];
	assert.equal(c.by, 'turbo');
	assert.equal(c.maker, 'OpenCode');
	assert.equal(c.engine, 'opencode');
	assert.equal(m.ownCommitLabel(c), 'Holds 13 lines OpenCode wrote');
	// anything else the CLI says is still your own commit
	assert.equal(m.parseSteps(answer({ turns: [{ ...answer().turns[0], own_commits: [{ ...turbo, by: 'robot' }] }] })).turns[0].own_commits[0].by, 'you');
});
