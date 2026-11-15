/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: What's new (patches/480-whats-new.patch).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { dispatchLabelStartsWith, findDispatchAnchor } from '../../browser/dispatchWhatsNewModel.js';

suite('dispatchWhatsNew', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('an anchor names whole words: a count or NEW may follow, another word may not', () => {
		assert.strictEqual(dispatchLabelStartsWith('Tasks', 'Tasks'), true);
		assert.strictEqual(dispatchLabelStartsWith('Tasks, preview', 'tasks'), true);
		assert.strictEqual(dispatchLabelStartsWith('Skills111', 'Skills'), true);
		assert.strictEqual(dispatchLabelStartsWith('Overview NEW', 'Overview'), true);
		assert.strictEqual(dispatchLabelStartsWith('tasks-tab.png', 'Tasks'), false);
		assert.strictEqual(dispatchLabelStartsWith('Tasks tab', 'Tasks tab'), true);
		assert.strictEqual(dispatchLabelStartsWith('Taskset', 'Tasks'), false);
	});

	test('the tab named Tasks, not a picture called tasks-tab.png', () => {
		const root = document.createElement('div');
		root.innerHTML = '<div class="tabs-container"><div class="tab" aria-label="tasks-tab.png"></div><div class="tab" aria-label="Tasks"></div></div>';
		document.body.appendChild(root);
		try {
			const found = findDispatchAnchor(document, { selector: '.tabs-container .tab', aria: 'Tasks' });
			assert.deepStrictEqual(found.map(el => el.getAttribute('aria-label')), ['Tasks']);
		} finally {
			root.remove();
		}
	});

	test('an entry still matches once its NEW is in it (textContent "OverviewNew")', () => {
		const root = document.createElement('div');
		root.innerHTML = '<div class="ai-customization-toolbar"><a class="customization-link-button"><span>Overview</span><span class="dispatch-new-badge">New</span></a></div>';
		document.body.appendChild(root);
		try {
			const found = findDispatchAnchor(document, { selector: '.ai-customization-toolbar .customization-link-button', text: 'Overview' });
			assert.strictEqual(found.length, 1);
		} finally {
			root.remove();
		}
	});
});
