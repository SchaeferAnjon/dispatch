// Learning while the agent works, the third part (user 2026-11-15, task-39x97, kanban design/learn-scene frames 1, 4
// and 5): Now's one sentence of why (only what the agent said: its `dispatch now` line, else what it wrote at the start
// of the turn before it did anything) and which blocks of Changes one model call asks Why for (the clicked one first,
// only those nothing says anything about yet, at most 16).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const vs = src ? path.join(src, 'src/vs') : fileURLToPath(new URL('../vscode/src/vs/', import.meta.url));
const M = await import(pathToFileURL(path.join(vs, 'sessions/contrib/dispatchLearn/common/dispatchExplainModel.ts')));

const text = t => ({ kind: 'text', text: t });
const call = { kind: 'call' };

test('the opening words: what the agent wrote before its first call', () => {
	assert.equal(M.openingWords([text('I\'ll add a daily reminder so the app can nudge you to read. It needs a scheduler file and a toggle in settings.'), call, text('Done.')]),
		'I\'ll add a daily reminder so the app can nudge you to read. It needs a scheduler file and a toggle in settings.');
	// two sentences at most
	assert.equal(M.openingWords([text('First I read the settings page. Then I add the toggle. Then the tests.'), call]), 'First I read the settings page. Then I add the toggle.');
	// words after the first call do not count
	assert.equal(M.openingWords([call, text('Now I edit the file.'), call]), '');
});

test('no call in the turn: an answer, not a plan; nothing', () => {
	assert.equal(M.openingWords([text('A worktree is a second copy of the project.')]), '');
	assert.equal(M.openingWords([]), '');
});

test('acknowledgements and list leads are passed over; Markdown becomes words', () => {
	assert.equal(M.openingWords([text('Sure!\n\nI will rename `count` in **app.ts** so the name says what it holds.'), call]), 'I will rename count in app.ts so the name says what it holds.');
	assert.equal(M.openingWords([text('Here\'s the plan:\n\n1. Create `notes.ts` to keep the notes.\n2. Change the theme.'), call]), 'Create notes.ts to keep the notes. Change the theme.');
	assert.equal(M.openingWords([text('OK.'), call]), '');
	assert.equal(M.openingWords([text('```ts\nconst a = 1;\n```\nUpdating v1.2 of the [config](file:///a/b.json) to dark.'), call]), 'Updating v1.2 of the config to dark.');
	assert.equal(M.openingWords([text('好的。我先建一个文件存笔记，再把主题改成深色。'), call]), '我先建一个文件存笔记，再把主题改成深色。');
});

test('a long plan is cut at a word, at most 220 characters', () => {
	const long = `I will ${'carefully '.repeat(40)}change the file.`;
	const got = M.openingWords([text(long), call]);
	assert.ok(got.length <= 220 && got.endsWith('…') && !/carefu…$/.test(got), got);
});

test('the why line: dispatch now when the head shows something else, else the opening words, never the head again', () => {
	// the head shows the agent's line: the why is its plan
	assert.deepEqual(M.nowWhy({ own: 'Adding a daily reminder', say: 'Adding a daily reminder', opening: 'I will add a scheduler file and a toggle so the app can remind you.' }),
		{ text: 'I will add a scheduler file and a toggle so the app can remind you.', from: 'plan' });
	// the head shows a question (waiting): the agent's own line is the why
	assert.deepEqual(M.nowWhy({ own: 'Adding a daily reminder', say: 'Which time should it remind you?', opening: 'I will add a scheduler.' }), { text: 'Adding a daily reminder', from: 'now' });
	// the plan says what the head already says: nothing
	assert.equal(M.nowWhy({ say: 'Editing app.ts to make the theme dark.', opening: 'Editing app.ts to make the theme dark.' }), undefined);
	assert.equal(M.nowWhy({ say: 'Working on your request.' }), undefined);
	assert.equal(M.nowWhy({ say: 'Working on your request.', opening: '' }), undefined);
});

test('the same words: case, spaces and marks aside, or one holding the other', () => {
	assert.ok(M.sameWords('Adding a reminder.', 'adding a REMINDER'));
	assert.ok(M.sameWords('Adding a daily reminder', 'Adding a daily reminder so the app can nudge you.'));
	assert.ok(!M.sameWords('Fix', 'Fix the build so the tests pass'));
	assert.ok(!M.sameWords('', ''));
});

test('Why on a block: what is said for the same lines first, else a block of the same file that shares a line', () => {
	const known = [{ path: '/p/a.ts', start: 3, end: 4, text: 'walk' }, { path: '/p/a.ts', start: 10, end: 12, text: 'x' }, { path: '/p/b.ts', start: 1, end: 9, text: 'new' }];
	assert.equal(M.knownFor({ path: '/p/a.ts', start: 3, end: 4 }, known).text, 'walk');
	assert.equal(M.knownFor({ path: '/p/a.ts', start: 12, end: 15 }, known).text, 'x');
	assert.equal(M.knownFor({ path: '/p/a.ts', start: 5, end: 9 }, known), undefined);
	assert.equal(M.knownFor({ path: '/p/c.ts', start: 1, end: 9 }, known), undefined);
	assert.equal(M.blockKey({ path: '/p/a.ts', start: 3, end: 4 }), '/p/a.ts:3-4');
});

test('one model call for the blocks shown: the clicked one first, only the unsaid ones, at most 16, none twice', () => {
	const b = (path, start) => ({ path, start, end: start + 1 });
	const all = [b('/a', 1), b('/a', 10), b('/b', 5), b('/c', 2), b('/a', 10)];
	const said = x => x.path === '/b';
	assert.deepEqual(M.blocksToAsk(all[3], all, said).map(M.blockKey), ['/c:2-3', '/a:1-2', '/a:10-11']);
	// the clicked one is said already: no call
	assert.deepEqual(M.blocksToAsk(all[2], all, said), []);
	const many = Array.from({ length: 40 }, (_, i) => b('/m', i * 10));
	const asked = M.blocksToAsk(many[30], many, () => false);
	assert.equal(asked.length, M.WHY_MAX_BLOCKS);
	assert.equal(asked[0], many[30]);
	assert.equal(M.WHY_MAX_BLOCKS, 16);
});
