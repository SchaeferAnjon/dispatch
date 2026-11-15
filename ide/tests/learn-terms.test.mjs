// Explain terms (learning while the agent works, the third part, user 2026-11-15, task-39x97, kanban
// design/learn-scene frame 4): the word list, and which words of a reply get the dotted line: each word only its first
// time in the reply, in any case, its plural too, never inside a name or a path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const vs = src ? path.join(src, 'src/vs') : fileURLToPath(new URL('../vscode/src/vs/', import.meta.url));
const T = await import(pathToFileURL(path.join(vs, 'workbench/contrib/chat/common/dispatchTerms.ts')));

const marked = (text, claimed = new Set()) => T.findTerms(text, claimed).map(m => text.slice(m.start, m.end));

test('the list: at most 30 words, each with one plain sentence', () => {
	assert.ok(T.DISPATCH_TERMS.length <= 30, `${T.DISPATCH_TERMS.length} words`);
	const names = T.DISPATCH_TERMS.map(t => t.term);
	assert.equal(new Set(names).size, names.length, 'no word twice');
	for (const want of ['Worktree', 'Commit', 'Branch', 'Diff', 'Merge', 'Dependency', 'Package', 'Build', 'Test', 'API', 'Terminal']) {
		assert.ok(names.includes(want), want);
	}
	for (const t of T.DISPATCH_TERMS) {
		assert.match(t.plain, /^[A-Z].{20,130}\.$/, t.term);
		assert.ok(!/[—–]/.test(t.plain), `${t.term}: no dashes`);
	}
});

test('a word is marked at its first place only, the rest of the reply leaves it alone', () => {
	const claimed = new Set();
	assert.deepEqual(marked('I made a commit, then another commit on the branch.', claimed), ['commit', 'branch']);
	// the next piece of the same reply: commit and branch are taken
	assert.deepEqual(marked('The commit is on the branch; the diff is small.', claimed), ['diff']);
	assert.deepEqual([...claimed].sort(), ['Branch', 'Commit', 'Diff']);
});

test('any case; plurals and the forms the list names', () => {
	assert.deepEqual(marked('Two Commits and three DEPENDENCIES.'), ['Commits', 'DEPENDENCIES']);
	assert.deepEqual(marked('All branches merged.'), ['branches', 'merged']);
	assert.deepEqual(marked('It committed the change.'), ['committed']);
	assert.deepEqual(marked('Two new packages for the libraries.'), ['packages', 'libraries']);
	assert.equal(T.pluralOf('dependency'), 'dependencies');
	assert.equal(T.pluralOf('branch'), 'branches');
	assert.equal(T.pluralOf('commit'), 'commits');
	assert.equal(T.pluralOf('key'), 'keys');
});

test('an acronym only in capitals: API and APIs, not "api" in a word or a path', () => {
	assert.deepEqual(marked('The API answers; two APIs.'), ['API']);
	assert.deepEqual(marked('the api folder'), []);
	assert.deepEqual(marked('Open a PR when done.'), ['PR']);
	assert.deepEqual(marked('pr is not a word here'), []);
});

test('a phrase wins over its part: merge conflict, not merge', () => {
	const claimed = new Set();
	assert.deepEqual(marked('There was a merge conflict.', claimed), ['merge conflict']);
	assert.ok(claimed.has('Conflict') && !claimed.has('Merge'));
	assert.deepEqual(marked('Then I could merge.', claimed), ['merge']);
	assert.deepEqual(marked('Open a pull request for it.'), ['pull request']);
	assert.deepEqual(marked('Set the environment  variable first.'), ['environment  variable']);
});

test('never inside a name, a path or a file: pre-commit, commit-msg, src/build, build.ts, #test', () => {
	assert.deepEqual(marked('The pre-commit hook runs.'), ['hook']);
	assert.deepEqual(marked('Edit commit-msg now.'), []);
	assert.deepEqual(marked('See src/build and build.ts and #test.'), []);
	assert.deepEqual(marked('Run the build.'), ['build']);
	assert.deepEqual(marked('Run the tests, then the build: done.'), ['tests', 'build']);
	assert.deepEqual(marked('rebuild and testing and committer'), []);
});

test('Chinese text around an English word', () => {
	assert.deepEqual(marked('我做了一个 commit，放在 worktree 里。'), ['commit', 'worktree']);
	assert.deepEqual(marked('提交到commit里'), ['commit']);
});

test('Explain terms is on unless switched off', () => {
	assert.equal(T.explainTermsOn(undefined), true);
	assert.equal(T.explainTermsOn(true), true);
	assert.equal(T.explainTermsOn(false), false);
	assert.equal(T.EXPLAIN_TERMS_SETTING, 'dispatch.learning.explainTerms');
});
