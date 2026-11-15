/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: tips and the Getting started checklist (patches/475-tours.patch).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DISPATCH_CHECKLIST, DISPATCH_TOURS } from '../../browser/dispatchToursData.js';
import { BUBBLE_MARGIN, checklistProgress, IDispatchTour, IDispatchTourAnchor, nextVisibleStepIndex, parseIdList, pickTour, placeBubble, previousVisibleStepIndex, stepProgress, TOUR_COOLDOWN_MS, tourDecision, visibleStepIndexes, withId } from '../../browser/dispatchToursModel.js';

const tour: IDispatchTour = {
	id: 't',
	order: 1,
	steps: [
		{ id: 'a', title: 'A', body: 'a', anchor: { selector: '.a' } },
		{ id: 'b', title: 'B', body: 'b', anchor: { selector: '.b' } },
		{ id: 'c', title: 'C', body: 'c', anchor: { selector: '.c' } },
	],
};
const everything = () => true;
const only = (...sel: string[]) => (a: IDispatchTourAnchor) => sel.includes(a.selector);
const base = { tour, enabled: true, wizardVisible: false, seenIds: [] as string[], activeTourId: null, now: 100_000, blockingSurface: undefined, targetExists: everything };

suite('dispatchTours', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a tour starts when its place is on screen and nothing is in the way', () => {
		assert.deepStrictEqual(tourDecision(base), { kind: 'start', stepIndex: 0 });
	});

	test('it never starts over the first-run setup, a dialog, another tip, or when tips are off', () => {
		assert.deepStrictEqual(tourDecision({ ...base, wizardVisible: true }), { kind: 'blocked', reason: 'wizard' });
		assert.deepStrictEqual(tourDecision({ ...base, blockingSurface: 'dialog' }), { kind: 'blocked', reason: 'blocking-surface' });
		assert.deepStrictEqual(tourDecision({ ...base, activeTourId: 'other' }), { kind: 'blocked', reason: 'active-tour' });
		assert.deepStrictEqual(tourDecision({ ...base, enabled: false }), { kind: 'blocked', reason: 'disabled' });
	});

	test('it shows once: seen tours stay away, a replay by hand does not mind', () => {
		assert.deepStrictEqual(tourDecision({ ...base, seenIds: ['t'] }), { kind: 'blocked', reason: 'seen' });
		assert.deepStrictEqual(tourDecision({ ...base, seenIds: ['t'], forced: true }), { kind: 'start', stepIndex: 0 });
		// a replay still never covers the setup
		assert.deepStrictEqual(tourDecision({ ...base, wizardVisible: true, forced: true }), { kind: 'blocked', reason: 'wizard' });
	});

	test('the next one waits a moment after one ended', () => {
		assert.deepStrictEqual(tourDecision({ ...base, lastEndedAt: base.now - 1000 }), { kind: 'blocked', reason: 'cooling-down' });
		assert.deepStrictEqual(tourDecision({ ...base, lastEndedAt: base.now - TOUR_COOLDOWN_MS }), { kind: 'start', stepIndex: 0 });
	});

	test('the place has to be on screen, and a step whose element is gone is left out', () => {
		assert.deepStrictEqual(tourDecision({ ...base, targetExists: () => false }), { kind: 'blocked', reason: 'missing-start-target' });
		const onlyBC = only('.b', '.c');
		assert.deepStrictEqual(visibleStepIndexes(tour, onlyBC), [1, 2]);
		assert.strictEqual(nextVisibleStepIndex(tour, 1, onlyBC), 2);
		assert.strictEqual(nextVisibleStepIndex(tour, 2, onlyBC), undefined);
		assert.strictEqual(previousVisibleStepIndex(tour, 2, onlyBC), 1);
		assert.strictEqual(previousVisibleStepIndex(tour, 1, onlyBC), undefined);
		assert.deepStrictEqual(stepProgress([1, 2], 2), { current: 2, total: 2 });
		assert.strictEqual(stepProgress([1, 2], 0), undefined);
		// the place is its own anchor, not the first step's
		const withPlace: IDispatchTour = { ...tour, place: { selector: '.page' } };
		assert.deepStrictEqual(tourDecision({ ...base, tour: withPlace, targetExists: only('.page', '.c') }), { kind: 'start', stepIndex: 2 });
		assert.deepStrictEqual(tourDecision({ ...base, tour: withPlace, targetExists: only('.a') }), { kind: 'blocked', reason: 'missing-start-target' });
	});

	test('of several places on screen the lowest order goes first, blocked ones are skipped', () => {
		const second: IDispatchTour = { ...tour, id: 'u', order: 2 };
		const first: IDispatchTour = { ...tour, id: 'v', order: 0 };
		const decide = (t: IDispatchTour) => tourDecision({ ...base, tour: t, seenIds: ['v'] });
		assert.strictEqual(pickTour([second, tour, first], decide)?.tour.id, 't');
		assert.strictEqual(pickTour([second, tour, first], t => tourDecision({ ...base, tour: t, seenIds: ['v', 't', 'u'] })), undefined);
	});

	test('the bubble goes under the element, arrow on its middle, kept inside the window', () => {
		const at = placeBubble({ left: 400, top: 100, width: 80, height: 30 }, { width: 320, height: 120 }, { width: 1200, height: 800 }, 'bottom');
		assert.strictEqual(at.side, 'bottom');
		assert.strictEqual(at.top, 142);
		assert.strictEqual(at.left, 280);
		assert.strictEqual(at.arrowOffset, 160);
		const edge = placeBubble({ left: 1160, top: 100, width: 30, height: 30 }, { width: 320, height: 120 }, { width: 1200, height: 800 }, 'bottom');
		assert.strictEqual(edge.left, 1200 - 320 - BUBBLE_MARGIN);
		// the arrow keeps off the bubble's rounded corner: 18 px from the edge at most
		assert.strictEqual(edge.arrowOffset, 320 - 18);
	});

	test('without room on the preferred side it takes another; without any it covers the element', () => {
		const flipped = placeBubble({ left: 400, top: 700, width: 80, height: 30 }, { width: 320, height: 120 }, { width: 1200, height: 800 }, 'bottom');
		assert.strictEqual(flipped.side, 'top');
		assert.strictEqual(flipped.top, 700 - 12 - 120);
		const right = placeBubble({ left: 20, top: 300, width: 200, height: 30 }, { width: 320, height: 120 }, { width: 1200, height: 800 }, 'left');
		assert.strictEqual(right.side, 'right');
		assert.strictEqual(right.left, 232);
		const page = placeBubble({ left: 0, top: 0, width: 400, height: 300 }, { width: 380, height: 280 }, { width: 400, height: 300 }, 'bottom');
		assert.strictEqual(page.side, 'over');
		assert.strictEqual(page.arrowOffset, undefined);
		assert.ok(page.left >= BUBBLE_MARGIN && page.top >= BUBBLE_MARGIN);
	});

	test('the remembered ids survive junk in storage', () => {
		assert.deepStrictEqual(parseIdList(undefined), []);
		assert.deepStrictEqual(parseIdList('not json'), []);
		assert.deepStrictEqual(parseIdList('{"a":1}'), []);
		assert.deepStrictEqual(parseIdList('["a",3,"b"]'), ['a', 'b']);
		assert.deepStrictEqual(withId(['a'], 'a'), ['a']);
		assert.deepStrictEqual(withId(['a'], 'b'), ['a', 'b']);
	});

	test('the ring draws done over total', () => {
		const none = checklistProgress(['a', 'b', 'c', 'd'], []);
		assert.deepStrictEqual([none.done, none.total, none.complete, none.drawn], [0, 4, false, 0]);
		const half = checklistProgress(['a', 'b', 'c', 'd'], ['a', 'c', 'zzz']);
		assert.strictEqual(half.done, 2);
		assert.ok(Math.abs(half.drawn - half.circumference / 2) < 1e-9);
		assert.strictEqual(checklistProgress(['a', 'b'], ['a', 'b']).complete, true);
		assert.strictEqual(checklistProgress([], []).complete, false);
	});

	test('the shipped tours and checklist hold together', () => {
		const ids = DISPATCH_TOURS.map(t => t.id);
		assert.strictEqual(new Set(ids).size, ids.length, 'tour ids are unique');
		for (const t of DISPATCH_TOURS) {
			assert.ok(t.steps.length >= 1 && t.steps.length <= 4, `${t.id}: one to four steps`);
			assert.strictEqual(new Set(t.steps.map(s => s.id)).size, t.steps.length, `${t.id}: step ids are unique`);
			for (const s of t.steps) {
				assert.ok(s.title.length > 0 && s.body.length > 0 && s.body.length <= 200, `${t.id}/${s.id}: a title and one or two short sentences`);
				assert.ok(!/[—–]/.test(s.title + s.body), `${t.id}/${s.id}: no long dashes`);
			}
		}
		assert.ok(DISPATCH_CHECKLIST.length >= 5 && DISPATCH_CHECKLIST.length <= 8, 'five to eight items');
		assert.strictEqual(new Set(DISPATCH_CHECKLIST.map(i => i.id)).size, DISPATCH_CHECKLIST.length);
		for (const i of DISPATCH_CHECKLIST) {
			const d = i.doneWhen;
			assert.ok(d.onScreen || d.commands?.length || d.request || d.chatRequest || d.check, `${i.id}: something ticks it`);
			assert.ok(!/[—–]/.test(i.title + i.description), `${i.id}: no long dashes`);
		}
	});
});
