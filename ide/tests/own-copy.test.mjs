import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const w = await import(moduleAt('platform/agentHost/node/dispatchOwnCopyWords.ts'));

const land = { main: '/Users/me/Projects/todo-web', into: 'main', folder_branch: 'experiment' };

test('the files a copy changed are listed the way a person says them', () => {
	assert.equal(w.fileList([]), '');
	assert.equal(w.fileList(['index.html']), 'index.html');
	assert.equal(w.fileList(['index.html', 'app.js']), 'index.html and app.js');
	assert.equal(w.fileList(['a', 'b', 'c']), 'a, b and c');
	assert.equal(w.fileList(['a', 'b', 'c', 'd', 'e']), 'a, b, c and 2 more');
});

test('a copy that went back says so by the folder name; one the person picked says Merge Changes (task-lj06.16)', () => {
	assert.equal(w.landNotice({ ...land, state: 'landed', files: ['index.html'] }), "This session's changes are in todo-web now: index.html.");
	assert.match(w.landNotice({ ...land, state: 'manual', ahead: 2 }), /not in todo-web yet\. Merge Changes/);
	assert.equal(w.landNotice({ ...land, state: 'manual', ahead: 0, dirty: false }), undefined);
	assert.equal(w.landNotice({ ...land, state: 'nothing' }), undefined);
	assert.equal(w.landNotice({ ...land, state: 'not_copy' }), undefined);
	assert.match(w.copyNotice('/Users/me/Projects/todo-web/'), /^Another agent is working in todo-web right now/);
});

test('the question card speaks plainly and always offers to keep the changes in the copy', () => {
	for (const kind of ['conflict', 'folder_changes', 'other_branch', 'waited']) {
		const q = w.question(kind, { ...land, files: ['index.html'] });
		const words = [q.title, q.message, ...q.options.flatMap(o => [o.label, o.description])].join(' ');
		assert.doesNotMatch(words, /worktree|conflict|rebase|HEAD/i, kind);
		assert.equal(q.options.at(-1).id, 'keep', kind);
		assert.ok(q.message.includes('todo-web'), kind);
	}
	const c = w.question('conflict', { ...land, files: ['index.html'] });
	assert.equal(c.options[0].id, 'combine');
	assert.match(c.message, /Both changed index\.html/);
	assert.equal(w.question('other_branch', land).options[0].label, 'Put them into experiment');
});

test('the prompt that lets the agent combine names the branch and the files', () => {
	const p = w.combinePrompt({ ...land, files: ['index.html'] });
	assert.match(p, /git merge main/);
	assert.match(p, /index\.html/);
	assert.match(p, /into todo-web after that/);
});

test('file URIs and paths become paths', () => {
	assert.equal(w.fsPath('file:///Users/me/My%20Project'), '/Users/me/My Project');
	assert.equal(w.fsPath('/tmp/x'), '/tmp/x');
	assert.equal(w.fsPath('vscode-remote://x/y'), undefined);
});

test('Separate copy picked after the session was made stays a copy at the first message (task-lj06.27)', () => {
	// held back as a folder session, then switched to Separate copy: the first message does not decide again
	assert.equal(w.firstMessageDecides({ deferred: true, pending: true, isolation: 'worktree', hasTurns: false }), false);
	assert.equal(w.firstMessageDecides({ deferred: false, pending: true, isolation: 'worktree', hasTurns: false }), false);
	// a folder session's first message decides; later messages and resumed sessions do not
	assert.equal(w.firstMessageDecides({ deferred: true, pending: true, isolation: 'folder', hasTurns: false }), true);
	assert.equal(w.firstMessageDecides({ deferred: false, pending: false, isolation: 'folder', hasTurns: false }), true);
	assert.equal(w.firstMessageDecides({ deferred: false, pending: false, isolation: 'folder', hasTurns: true }), false);
	assert.equal(w.firstMessageDecides({ deferred: false, pending: true, isolation: undefined, hasTurns: false }), false);
});
