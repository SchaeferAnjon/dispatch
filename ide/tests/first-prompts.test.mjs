import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const { firstPromptsFailureKind } = await import(moduleAt('sessions/contrib/dispatchOnboarding/common/dispatchFirstPromptsFailure.ts'));

test('a timed out CLI is a busy Mac, not a broken one (dispatch assistant --json timed out)', () => {
	assert.equal(firstPromptsFailureKind('dispatch assistant --json timed out'), 'busy');
	assert.equal(firstPromptsFailureKind('Timeout'), 'busy');
});

test('the other causes keep their own words', () => {
	assert.equal(firstPromptsFailureKind('argument op: invalid choice: assistant'), 'old-cli');
	assert.equal(firstPromptsFailureKind('python3: spawn ENOENT'), 'no-cli');
	assert.equal(firstPromptsFailureKind('Traceback ... KeyError'), 'other');
	assert.equal(firstPromptsFailureKind(undefined), 'none');
	assert.equal(firstPromptsFailureKind('  '), 'none');
});
