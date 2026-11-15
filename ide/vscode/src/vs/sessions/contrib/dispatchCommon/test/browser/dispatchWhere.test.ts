/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: 「在哪」 (patches/070-where-is-what.patch).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { dispatchMarkLine, dispatchPictureScale, dispatchThumbCrop, dispatchWherePictureOf, DispatchWhereViewer, IDispatchMarks, parseDispatchMarks, renderDispatchWhereLegend, renderDispatchWhereThumb } from '../../browser/dispatchWhere.js';

suite('dispatchWhere', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the marks JSON and the docs list where, drops marks without a box', () => {
		const a = parseDispatchMarks({
			v: 1, image: '00-where.png', size: [2880, 1774], scale: 2, marks: [
				{ n: 1, box: [770, 374, 1708, 184], color: 'red', what: 'Find Skills', where: 'Overview', how: 'scroll down' },
				{ n: 2, box: [26, 72, 372, 66], color: 'green', note: '这个别动' },
				{ n: 3, box: [1, 2, 0, 4] },
				{ n: 4 },
			],
		});
		assert.deepStrictEqual(a, {
			v: 1, image: '00-where.png', size: [2880, 1774], scale: 2, drawn: false, marks: [
				{ n: 1, box: [770, 374, 1708, 184], color: 'red', what: 'Find Skills', where: 'Overview', how: 'scroll down', note: undefined, image: undefined },
				{ n: 2, box: [26, 72, 372, 66], color: 'green', what: undefined, where: undefined, how: undefined, note: '这个别动', image: undefined },
			],
		});
		assert.strictEqual(parseDispatchMarks({ image: 'x.png', drawn: true, marks: [{ n: 1, box: [0, 0, 5, 5] }] })?.drawn, true);
		const b = parseDispatchMarks({ image: 'x.png', items: [{ box: [0, 0, 10, 10], what: 'a' }, { box: [5, 5, 10, 10], what: 'b' }] });
		assert.deepStrictEqual(b?.marks.map(m => m.n), [1, 2]);
		assert.strictEqual(parseDispatchMarks({ marks: [] }), undefined);
		assert.strictEqual(parseDispatchMarks('nope'), undefined);
	});

	test('a line is the note, or what · where · how', () => {
		assert.strictEqual(dispatchMarkLine({ n: 1, box: [0, 0, 1, 1], note: '改成方角' }), '改成方角');
		assert.strictEqual(dispatchMarkLine({ n: 1, box: [0, 0, 1, 1], what: 'Find Skills', how: 'scroll down' }), 'Find Skills · scroll down');
	});

	test('Retina pictures show at half their pixels unless the JSON says otherwise', () => {
		assert.strictEqual(dispatchPictureScale({ size: [2880, 1800] }), 2);
		assert.strictEqual(dispatchPictureScale({ size: [800, 600] }), 1);
		assert.strictEqual(dispatchPictureScale({ scale: 1, size: [2880, 1800] }), 1);
		assert.strictEqual(dispatchPictureScale({}, 1700), 2);
	});

	test('a thumbnail crops to the marks plus a margin, 3:2, inside the picture', () => {
		const [x, y, w, h] = dispatchThumbCrop([1620, 1258], [{ n: 1, box: [26, 72, 372, 66] }], 144, 96);
		assert.ok(Math.abs(w / h - 1.5) < 0.01, `ratio ${w / h}`);
		assert.ok(x <= 26 - 0 && x >= 0 && y >= 0, `origin ${x},${y}`);
		assert.ok(x + w >= 26 + 372 && y + h >= 72 + 66, 'the box is inside the crop');
		assert.ok(x + w <= 1620 && y + h <= 1258, 'the crop is inside the picture');
		assert.deepStrictEqual(dispatchThumbCrop([1620, 1080], [], 72, 48, 'marks'), [0, 0, 1620, 1080]);
	});

	test('numbered lines are neutral dots with the line', () => {
		const ol = renderDispatchWhereLegend(undefined, [{ n: 1, box: [0, 0, 1, 1], what: 'Find Skills', where: 'Overview' }, { n: 2, box: [0, 0, 1, 1], note: '别动' }], { max: 1 });
		assert.strictEqual(ol.children.length, 1);
		assert.strictEqual(ol.querySelector('.n')?.textContent, '1');
		assert.strictEqual(ol.querySelector('em')?.textContent, 'Find Skills');
		assert.strictEqual(ol.querySelector('li')?.getAttribute('aria-label'), '1. Find Skills · Overview');
	});

	const picture: IDispatchMarks = {
		image: '', size: [1200, 800], scale: 2, marks: [
			{ n: 1, box: [100, 100, 200, 100], what: 'Save' },
			{ n: 2, box: [700, 500, 100, 60], color: 'green', note: '别动' },
		],
	};

	function mount(width: number): HTMLElement {
		const parent = document.createElement('div');
		parent.style.width = `${width}px`;
		document.body.appendChild(parent);
		return parent;
	}

	test('the viewer starts on the whole picture and draws every box on a raw screenshot', () => {
		const parent = mount(600);
		const v = new DispatchWhereViewer(parent, picture, undefined, { side: false });
		try {
			v.layout(true);
			assert.strictEqual(v.selected, undefined);
			assert.strictEqual(parent.querySelectorAll('.vp .rb').length, 2);
			assert.strictEqual(parent.querySelector('.vp .rb.g .k')?.textContent, '2');
			// the whole picture at the viewer's width, at most 1:1 in points: 1200 px at 2x is 600 points wide
			const h = parseFloat(v.viewport.style.height);
			assert.ok(h > 380 && h <= 400, `height ${h}`);
			assert.strictEqual(parent.querySelector<HTMLElement>('.vp .mask')?.hidden, true);
			assert.strictEqual(dispatchWherePictureOf(parent.querySelector('img')!), picture);
		} finally {
			v.dispose();
			parent.remove();
		}
	});

	test('a line zooms to its box, the same line or Whole picture goes back', () => {
		const parent = mount(600);
		const v = new DispatchWhereViewer(parent, picture, undefined, { side: false });
		const picked: (number | undefined)[] = [];
		const l = v.onDidSelect(n => picked.push(n));
		try {
			v.layout(true);
			const whole = parent.querySelector<HTMLElement>('.wh .dispatch-where-ghost')!;
			assert.strictEqual(whole.hidden, true);
			const line2 = parent.querySelector<HTMLElement>('li[data-n="2"]')!;
			line2.click();
			assert.strictEqual(v.selected, 2);
			assert.ok(line2.classList.contains('on'));
			assert.strictEqual(whole.hidden, false);
			assert.strictEqual(parent.querySelector<HTMLElement>('.vp .mask')?.hidden, false);
			line2.click();
			assert.strictEqual(v.selected, undefined);
			v.select(1);
			whole.click();
			assert.strictEqual(v.selected, undefined);
			assert.deepStrictEqual(picked, [2, undefined, 1, undefined]);
		} finally {
			l.dispose();
			v.dispose();
			parent.remove();
		}
	});

	test('a picture that has its boxes already gets none drawn over it', () => {
		const parent = mount(600);
		const v = new DispatchWhereViewer(parent, { ...picture, drawn: true }, undefined, { side: false, selected: 1 });
		try {
			v.layout(true);
			assert.strictEqual(parent.querySelectorAll('.vp .rb').length, 0);
			assert.strictEqual(v.selected, 1);
		} finally {
			v.dispose();
			parent.remove();
		}
	});

	test('a thumbnail outlines the boxes of a raw picture only', () => {
		const raw = renderDispatchWhereThumb('data:image/png;base64,', picture, { size: [96, 64], only: [1] });
		assert.strictEqual(raw.querySelectorAll('.rb').length, 1);
		const burned = renderDispatchWhereThumb('data:image/png;base64,', { ...picture, drawn: true }, { size: [96, 64] });
		assert.strictEqual(burned.querySelectorAll('.rb').length, 0);
	});
});
