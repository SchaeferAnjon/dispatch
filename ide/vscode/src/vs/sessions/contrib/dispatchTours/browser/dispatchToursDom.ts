/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: tips, what the page looks like (the model's rules need to know whether an element
 *  is really on screen, and what covers the window). Finding an element reuses What's new's anchors.
 *--------------------------------------------------------------------------------------------*/

import { findDispatchAnchor } from '../../dispatchWhatsNew/browser/dispatchWhatsNewModel.js';
import { IDispatchTourAnchor, IDispatchTourRect } from './dispatchToursModel.js';

function ancestorsShown(el: HTMLElement): boolean {
	if (el.closest('[hidden],[inert]')) {
		return false;
	}
	const view = el.ownerDocument.defaultView;
	if (!view) {
		return true;
	}
	for (let c: HTMLElement | null = el; c; c = c.parentElement) {
		const s = view.getComputedStyle(c);
		if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') {
			return false;
		}
	}
	return true;
}

export function rectOf(el: HTMLElement): IDispatchTourRect {
	const r = el.getBoundingClientRect();
	return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** A scroll area or a clipping box between the element and the window hides it (a row scrolled out of a list). */
function clippedAway(el: HTMLElement): boolean {
	const view = el.ownerDocument.defaultView;
	if (!view) {
		return false;
	}
	const r = el.getBoundingClientRect();
	for (let c = el.parentElement; c && c !== el.ownerDocument.body; c = c.parentElement) {
		const s = view.getComputedStyle(c);
		if (s.overflowX === 'visible' && s.overflowY === 'visible') {
			continue;
		}
		const box = c.getBoundingClientRect();
		if (box.width === 0 || box.height === 0) {
			continue;
		}
		const w = Math.min(r.right, box.right) - Math.max(r.left, box.left);
		const h = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top);
		if (w < Math.min(4, r.width) || h < Math.min(4, r.height)) {
			return true;
		}
	}
	return false;
}

/** On screen: shown, it has a size, part of it is inside the window and no scroll area has it out of sight. */
export function isOnScreen(el: HTMLElement): boolean {
	if (!el.isConnected || !ancestorsShown(el)) {
		return false;
	}
	const view = el.ownerDocument.defaultView;
	if (!view) {
		return false;
	}
	const r = el.getBoundingClientRect();
	if (!(r.width > 0 && r.height > 0)) {
		return false;
	}
	const w = Math.min(r.right, view.innerWidth) - Math.max(r.left, 0);
	const h = Math.min(r.bottom, view.innerHeight) - Math.max(r.top, 0);
	return w >= 4 && h >= 4 && !clippedAway(el);
}

/** The first element of the anchor that is on screen. */
export function findOnScreen(doc: Document, anchor: IDispatchTourAnchor): HTMLElement | undefined {
	return findDispatchAnchor(doc, anchor).find(isOnScreen);
}

/** Something covers the window: a dialog, the Customizations page, the command palette, a menu, another tour, What's new. */
export function blockingSurface(doc: Document): string | undefined {
	const shown = (sel: string): boolean => [...doc.querySelectorAll<HTMLElement>(sel)].some(e => {
		const r = e.getBoundingClientRect();
		return r.width > 0 && r.height > 0 && ancestorsShown(e);
	});
	// VS Code's dialogs and Dispatch's own (Add a project: a tip sat on its name field, kanban task-lj06.21)
	if (shown('.monaco-dialog-modal-block, .dispatch-ap-scrim')) {
		return 'dialog';
	}
	if (shown('.monaco-modal-editor-block')) {
		return 'modal-page';
	}
	if (shown('.quick-input-widget')) {
		return 'quick-input';
	}
	if (shown('.context-view .monaco-menu-container, .context-view .monaco-select-box-dropdown-container, .context-view .context-view-content')) {
		return 'menu';
	}
	if (shown('.spotlight-overlay')) {
		return 'vscode-tour';
	}
	if (shown('.monaco-hover.dispatch-whats-new-hover, .monaco-hover.dispatch-checklist-hover')) {
		return 'card';
	}
	if (shown('.dispatch-onboarding')) {
		return 'wizard';
	}
	// Dispatch's own Settings (dispatchSettings): the sessions a tip would point at are behind it
	if (shown('.part.sidebar.dispatch-settings-open > .dispatch-settings-nav')) {
		return 'settings';
	}
	return undefined;
}
