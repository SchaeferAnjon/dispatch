/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Add project, the plain functions (patches/440-projects.patch).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { addressName, destination, failureMessage, looksLikeAddress, nameProblem, progressLine, tildePath } from '../../browser/dispatchAddProjectModel.js';

suite('Dispatch add project', () => {

	test('paths are written from the home folder', () => {
		assert.strictEqual(tildePath('/Users/me/Projects/x', '/Users/me'), '~/Projects/x');
		assert.strictEqual(tildePath('/Users/me', '/Users/me/'), '~');
		assert.strictEqual(tildePath('/Users/mer/x', '/Users/me'), '/Users/mer/x');
		assert.strictEqual(destination('/Users/me/Projects/', 'my-app', '/Users/me'), '~/Projects/my-app');
		assert.strictEqual(destination('/Users/me/Projects', ' ', '/Users/me'), '~/Projects/');
	});

	test('a web address suggests the folder name', () => {
		assert.strictEqual(addressName('https://github.com/octocat/Hello-World'), 'Hello-World');
		assert.strictEqual(addressName('https://github.com/octocat/Hello-World.git/'), 'Hello-World');
		assert.strictEqual(addressName('git@github.com:octocat/Hello-World.git'), 'Hello-World');
		assert.strictEqual(addressName('https://github.com/o/r?tab=readme#top'), 'r');
		assert.strictEqual(addressName(''), '');
	});

	test('what counts as a web address', () => {
		for (const ok of ['https://github.com/octocat/Hello-World', 'http://x.org/a', 'ssh://git@host/a/b', 'git@github.com:o/r.git', 'github.com/o/r', '/Users/me/Projects/x', 'file:///tmp/x']) {
			assert.ok(looksLikeAddress(ok), ok);
		}
		for (const bad of ['', 'hello', 'o/r', '--upload-pack=x', 'ext::sh -c x', 'https://a b', 'https://']) {
			assert.ok(!looksLikeAddress(bad), bad);
		}
	});

	test('a project name that cannot be used says why, an empty one says nothing yet', () => {
		assert.strictEqual(nameProblem(''), undefined);
		assert.strictEqual(nameProblem('  '), undefined);
		assert.strictEqual(nameProblem('my app 2'), undefined);
		assert.strictEqual(nameProblem('讲书'), undefined);
		for (const bad of ['a/b', 'a\\b', 'a:b', '.hidden', '-x', 'x'.repeat(101)]) {
			assert.ok(nameProblem(bad), bad);
		}
	});

	test('progress and failures are in words', () => {
		assert.strictEqual(progressLine(undefined), 'Connecting');
		assert.strictEqual(progressLine({ phase: 'Downloading files', detail: '1.2 MiB | 2 MiB/s' }), 'Downloading files, 1.2 MiB | 2 MiB/s');
		assert.strictEqual(progressLine({ phase: 'Setting up the folder' }), 'Setting up the folder');
		assert.strictEqual(failureMessage({ ok: false, message: 'No project there.' }), 'No project there.');
		assert.strictEqual(failureMessage(undefined), 'Dispatch did not answer. Try again.');
	});
});
