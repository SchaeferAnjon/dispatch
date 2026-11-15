/*---------------------------------------------------------------------------------------------
 *  Dispatch: default Codex threads to the largest context window their model supports.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { codexContextSizeProperty, resolveCodexContextSize } from '../../../node/codex/codexContextSize.js';

suite('CodexContextSize', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the picker defaults to the largest window', () => {
		const property = codexContextSizeProperty(272_000, 872_000);
		assert.deepStrictEqual({ enum: property?.enum, default: property?.default }, { enum: [272_000, 872_000], default: 872_000 });
	});

	test('the user\'s configured window becomes the default, clamped to the maximum and offered when it lies between', () => {
		const pick = (user: number) => { const p = codexContextSizeProperty(272_000, 872_000, user); return { enum: p?.enum, default: p?.default }; };
		assert.deepStrictEqual(pick(1_000_000), { enum: [272_000, 872_000], default: 872_000 });
		assert.deepStrictEqual(pick(500_000), { enum: [272_000, 500_000, 872_000], default: 500_000 });
		assert.deepStrictEqual(pick(100_000), { enum: [100_000, 272_000, 872_000], default: 100_000 });
		assert.deepStrictEqual(pick(272_000), { enum: [272_000, 872_000], default: 272_000 });
	});

	test('a model with no larger size offers no picker', () => {
		assert.strictEqual(codexContextSizeProperty(272_000, 272_000), undefined);
		assert.strictEqual(codexContextSizeProperty(0, 872_000), undefined);
	});

	test('a picked size the model still offers wins, otherwise the picker default is used', () => {
		assert.strictEqual(resolveCodexContextSize(272_000, [272_000, 872_000], 872_000), 272_000);
		assert.strictEqual(resolveCodexContextSize(undefined, [272_000, 872_000], 872_000), 872_000);
		assert.strictEqual(resolveCodexContextSize(500_000, [272_000, 872_000], 872_000), undefined);
		assert.strictEqual(resolveCodexContextSize(undefined, undefined, undefined), undefined);
	});
});
