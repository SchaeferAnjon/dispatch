import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const copy = await import(moduleAt('sessions/common/dispatchSeparateCopy.ts'));

test('a separate copy goes by its project\'s name (kanban task-lj06.28)', () => {
	// the report: the terminal picker and the title bar after a handoff said the copy's folder name
	assert.deepEqual(copy.separateCopyOf('/Users/me/Projects/todo-web.worktrees/create-a-simple-to-do-list-page-in'), { path: '/Users/me/Projects/todo-web', name: 'todo-web' });
	assert.equal(copy.folderDisplayName('/Users/me/Projects/todo-web.worktrees/create-a-simple-to-do-list-page-in/'), 'todo-web');
	assert.equal(copy.folderDisplayName('/Users/me/Projects/计时器.worktrees/fix'), '计时器');
});

test('any other folder keeps its own name', () => {
	assert.equal(copy.separateCopyOf('/Users/me/Projects/todo-web'), undefined);
	assert.equal(copy.separateCopyOf('/Users/me/.worktrees/x'), undefined);
	assert.equal(copy.separateCopyOf('/x'), undefined);
	assert.equal(copy.folderDisplayName('/Users/me/Projects/todo-web'), 'todo-web');
	assert.equal(copy.folderDisplayName('/Users/me/Projects/todo-web.worktrees'), 'todo-web.worktrees');
});
