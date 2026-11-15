/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the draw tool (patches/320-draw-and-ask.patch).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { renderDispatchMarksText } from '../../../../../platform/agentHost/common/meta/dispatchMarksAttachmentMeta.js';
import { dispatchSnapTarget, IDispatchSnapTarget } from '../../browser/dispatchDrawTool.js';

suite('dispatchDrawTool', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const targets: IDispatchSnapTarget[] = [
		{ box: [0, 0, 1000, 800], label: 'main', depth: 2, key: '0' },
		{ box: [64, 64, 240, 64], label: 'button#save', depth: 4, key: '1' },
		{ box: [64, 64, 240, 64], label: 'span', depth: 5, key: '2' },
		{ box: [320, 64, 160, 64], label: 'button#cancel', depth: 4, key: '3' },
	];

	test('a box a few pixels off an element snaps to it (2 picture px per screen px)', () => {
		const t = dispatchSnapTarget([56, 70, 252, 50], targets, 0.5);
		assert.strictEqual(t?.label, 'span');
	});

	test('a box that matches nothing does not snap', () => {
		assert.strictEqual(dispatchSnapTarget([600, 400, 120, 90], targets, 0.5), undefined);
	});

	test('a box mostly over one element snaps to it even when an edge is far off', () => {
		const t = dispatchSnapTarget([330, 60, 180, 70], targets, 1);
		assert.strictEqual(t?.key, '3');
	});

	test('the text for the agent: one row per box, the element under it, the page, the source', () => {
		const text = renderDispatchMarksText({
			v: 1, size: [1600, 1000],
			marks: [{ n: 1, box: [64, 64, 240, 64], color: 'red', note: '圆角改成 8' }, { n: 2, box: [320, 64, 160, 64], color: 'green' }],
			elements: [{ n: 1, selector: 'button#save.primary', size: [120, 32], text: 'Save changes', html: '<button id="save" class="primary">Save changes</button>', style: 'border-radius: 999px', path: 'body > div.bar > button#save.primary' }],
			page: { url: 'file:///demo/page.html', viewport: [800, 500] },
			source: 'file:///demo/page.html',
		}, 2);
		assert.deepStrictEqual(text.split('\n'), [
			'Marks on image 2 (1600×1000 px, origin top-left, x y w h):',
			'1 red   64 64 240 64   圆角改成 8',
			'  element: button#save.primary, 120×32 CSS px, text "Save changes"',
			'  path: body > div.bar > button#save.primary',
			'  html: <button id="save" class="primary">Save changes</button>',
			'  style: border-radius: 999px',
			'2 green 320 64 160 64  (no note)',
			'Page: file:///demo/page.html (the image is its 800×500 CSS px viewport)',
			'Source: file:///demo/page.html',
		]);
	});
});
