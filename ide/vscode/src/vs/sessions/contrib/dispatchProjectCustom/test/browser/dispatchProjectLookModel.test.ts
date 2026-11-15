/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a project's own icon, the plain part (patches/445-project-custom.patch).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { dispatchProjectLook } from '../../browser/dispatchProjectLookModel.js';

suite('Dispatch project look', () => {

	test('a project without a look is the plain folder', () => {
		assert.strictEqual(dispatchProjectLook(undefined), undefined);
		assert.strictEqual(dispatchProjectLook({ icon: 'folder' }), undefined);
		assert.deepStrictEqual(dispatchProjectLook({ icon: 'folder', color: 'teal' }), { icon: 'folder', color: 'teal' });
	});

	test('what the CLI sends is drawn, anything else falls back to the folder', () => {
		assert.deepStrictEqual(dispatchProjectLook({ icon: 'symbol', symbol: 'rocket', color: 'amber' }), { icon: 'symbol', symbol: 'rocket', color: 'amber' });
		assert.deepStrictEqual(dispatchProjectLook({ icon: 'emoji', emoji: '🚀' }), { icon: 'emoji', emoji: '🚀', color: undefined });
		assert.deepStrictEqual(dispatchProjectLook({ icon: 'picture', picture_data: 'data:image/png;base64,AAAA' }), { icon: 'picture', picture_data: 'data:image/png;base64,AAAA', color: undefined });
		assert.strictEqual(dispatchProjectLook({ icon: 'symbol', symbol: 'x y"' }), undefined);
		assert.strictEqual(dispatchProjectLook({ icon: 'picture', picture_data: 'https://example.com/a.png' }), undefined);
		assert.strictEqual(dispatchProjectLook({ icon: 'letters', color: 'pink' }), undefined);
	});
});
