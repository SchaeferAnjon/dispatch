/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Waiting for you in the sessions list (425-waiting.patch; since 2026-11-11 direction A of
 *  design/home-now, task-0v1o9): its entry (a thin bell, this week's number), and a session row's end saying what that
 *  session asks. The rows under the entry are dispatchWaitingSidebar.ts's. sessionsList.ts calls these.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun, derived, IObservable } from '../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ICustomViewService } from '../../../../services/customView/browser/customViewService.js';
import { ISession } from '../../../../services/sessions/common/session.js';
import { dispatchWaitingHover, dispatchWaitingVisible, dispatchWaitingWeek, enterWaitingHover, findWaitingItem, leaveWaitingHover, waitingDetail } from '../dispatchWaitingModel.js';
import { DISPATCH_WAITING_SECTION_ID, markDispatchSidebarGroupEnd } from './dispatchWaitingSidebar.js';

/** The custom view the Waiting for you entry opens. */
export const DISPATCH_WAITING_VIEW_ID = 'dispatch.waitingForYou';

/**
 * A session waiting for an approval or a decision ends its row with what it asks, in its own words (dispatch
 * waiting): the command, the file with its verb, the question. Pointing at the row lights the same thing's row under
 * Waiting for you and on the Waiting for you page, and the other way round (DESIGN.md 联动悬停).
 */
export function bindWaitingSessionRow(container: HTMLElement, phraseElement: HTMLElement, session: ISession, store: DisposableStore): void {
	store.add(autorun(reader => {
		const item = findWaitingItem(dispatchWaitingVisible.read(reader), session.resource);
		const phrase = item && (item.kind === 'approve' || item.kind === 'decide') ? waitingDetail(item) : '';
		container.classList.toggle('dispatch-waiting', !!phrase);
		phraseElement.textContent = phrase;
		phraseElement.title = phrase;
	}));
	store.add(toDisposable(() => container.classList.remove('dispatch-waiting')));
	const waitingItem = () => findWaitingItem(dispatchWaitingVisible.get(), session.resource);
	store.add(DOM.addDisposableListener(container, DOM.EventType.MOUSE_ENTER, () => {
		const item = waitingItem();
		if (item) {
			enterWaitingHover(item.id, 'row');
		}
	}));
	store.add(DOM.addDisposableListener(container, DOM.EventType.MOUSE_LEAVE, () => {
		const item = waitingItem();
		if (item) {
			leaveWaitingHover(item.id);
		}
	}));
	store.add(autorun(reader => {
		const hover = dispatchWaitingHover.read(reader);
		const item = findWaitingItem(dispatchWaitingVisible.read(reader), session.resource);
		container.closest('.monaco-list-row')?.classList.toggle('dispatch-linked', !!item && (hover?.from === 'page' || hover?.from === 'sidebar') && hover.id === item.id);
	}));
	store.add(toDisposable(() => container.closest('.monaco-list-row')?.classList.remove('dispatch-linked')));
}

/**
 * Waiting for you's entry: a 36 high ghost row, the codicon's thin bell in grey, on the right in 11px grey the number
 * of things that moved in the last 7 days (dispatchWaitingWeek), nothing at 0. Selected while the page is open.
 */
export function renderWaitingSection(template: { readonly container: HTMLElement; readonly icon: HTMLElement; readonly label: HTMLElement; readonly count: HTMLElement; readonly elementDisposables: DisposableStore }, label: string, customViewService: ICustomViewService): void {
	DOM.clearNode(template.icon);
	template.icon.style.display = '';
	template.icon.className = `session-section-icon ${ThemeIcon.asClassName(Codicon.bell)}`;
	template.label.textContent = label;
	template.count.classList.add('dispatch-waiting-count');
	markDispatchSidebarGroupEnd(template.container, DISPATCH_WAITING_SECTION_ID, template.elementDisposables);
	template.elementDisposables.add(autorun(reader => {
		template.container.classList.toggle('active', customViewService.activeCustomView.read(reader)?.id === DISPATCH_WAITING_VIEW_ID);
		const n = dispatchWaitingWeek.read(reader)?.week.length ?? 0;
		template.count.textContent = n ? String(n) : '';
		template.count.style.display = n ? '' : 'none';
	}));
}

/** The entry's number, read out: what needs the person this week (the section itself holds no sessions). */
export function waitingSectionAriaLabel(label: string): IObservable<string> {
	return derived(reader => {
		const n = dispatchWaitingWeek.read(reader)?.week.length ?? 0;
		return n === 0 ? label
			: n === 1 ? localize('dispatchWaitingSectionAriaOne', "{0}, 1 item needs you", label)
				: localize('dispatchWaitingSectionAria', "{0}, {1} items need you", label, n);
	});
}
