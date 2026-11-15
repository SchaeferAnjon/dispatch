/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: paths in chat replies (patches/325-path-links.patch).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { findPathCandidates } from '../../browser/widget/chatContentParts/dispatchPathDetector.js';

function paths(text: string): string[] {
	return findPathCandidates(text).map(c => text.slice(c.start, c.end));
}

suite('Dispatch path links', () => {

	test('relative, absolute, home and line-numbered paths', () => {
		assert.deepStrictEqual(paths('样稿在 design/waiting/index.html，定稿写在 design/task-model/DECISIONS.md。'), ['design/waiting/index.html', 'design/task-model/DECISIONS.md']);
		assert.deepStrictEqual(paths('see /Users/me/Projects/kanban/app/cli/dispatch.py and ~/notes/today.md'), ['/Users/me/Projects/kanban/app/cli/dispatch.py', '~/notes/today.md']);
		assert.deepStrictEqual(paths('截图 design/phase1/E/02-session-dark.png 里'), ['design/phase1/E/02-session-dark.png']);
		assert.deepStrictEqual(paths('./src/a.ts and ../b/c.png'), ['./src/a.ts', '../b/c.png']);
		assert.deepStrictEqual(paths('open README.md first'), ['README.md']);
		assert.deepStrictEqual(paths('the folder design/docs-tab/ has it'), ['design/docs-tab/']);
	});

	test('line and column suffixes', () => {
		const [c] = findPathCandidates('bug at app/cli/dispatch.py:120.');
		assert.deepStrictEqual({ path: c.path, line: c.line, column: c.column }, { path: 'app/cli/dispatch.py', line: 120, column: undefined });
		const [d] = findPathCandidates('src/x.ts:12:5');
		assert.deepStrictEqual({ path: d.path, line: d.line, column: d.column }, { path: 'src/x.ts', line: 12, column: 5 });
		const [e] = findPathCandidates('src/x.ts#L40');
		assert.deepStrictEqual({ path: e.path, line: e.line }, { path: 'src/x.ts', line: 40 });
	});

	test('versions, fractions, expressions and URLs are not paths', () => {
		assert.deepStrictEqual(paths('released v1.2.3 and 1.139.1'), []);
		assert.deepStrictEqual(paths('a/b and/or 1/2 km/s x/y/z'), []);
		assert.deepStrictEqual(paths('ratio 3.5 or x.5'), []);
		assert.deepStrictEqual(paths('https://github.com/a/b/blob/main/README.md'), []);
		assert.deepStrictEqual(paths('see http://localhost:5173/design/a.html now'), []);
		assert.deepStrictEqual(paths('file:///Users/me/a.md'), []);
		assert.deepStrictEqual(paths('mail me at dev@example.com'), []);
	});

	test('sentence punctuation around a path', () => {
		assert.deepStrictEqual(paths('(see design/a/README.md).'), ['design/a/README.md']);
		assert.deepStrictEqual(paths('"docs/x.md", then'), ['docs/x.md']);
	});
});
