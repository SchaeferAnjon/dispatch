/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Dispatch's icon on the empty editor, its ten blocks dropping in, and Dispatch's shortcuts
 *  under it (815-editor-watermark.patch). editorGroupWatermark.ts puts it in place of the letterpress.
 *--------------------------------------------------------------------------------------------*/

import { dispatchIconDrop, dispatchIconElement } from '../../../../base/browser/dispatchIcon.js';
import { ensureDispatchPalette } from '../../../../base/browser/dispatchPalette.js';
import { DISPATCH_ICON_DROP } from '../../../../base/common/dispatchIcon.js';
import { $, addDisposableListener, getWindow } from '../../../../base/browser/dom.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import './media/dispatchEditorMark.css';

// Dispatch IDE: the shortcuts under the icon, like Cursor's empty editor. Commands the bridge extension
// contributes (dispatch.*) have their keybinding before the extension runs, so none of these is filtered
// out by the command registry; a row without a keybinding is skipped when it renders.
export const dispatchEntries: readonly { readonly id: string; readonly text: string }[] = [
	{ text: localize('watermark.dispatch.openChat', "Open Chat"), id: 'dispatch.focusChat' },
	{ text: localize('watermark.dispatch.agentsWindow', "Dispatch Agent"), id: 'dispatch.openAgentsWindow' },
	{ text: localize('watermark.dispatch.newSession', "New Session"), id: 'workbench.action.chat.newChat' },
	{ text: localize('watermark.dispatch.openFile', "Open File"), id: 'workbench.action.quickOpen' },
	{ text: localize('watermark.dispatch.showCommands', "Command Palette"), id: 'workbench.action.showCommands' },
	{ text: localize('watermark.dispatch.toggleTerminal', "Toggle Terminal"), id: 'workbench.action.terminal.toggleTerminal' },
];

/** The empty editor's logo, px wide: its blocks 28px like the loading splash's, the dot's glow inside the box
 *  (base/common/dispatchIcon.ts's mark, preference「logo 处处同应用图标」). */
const MARK_SIZE = 153;

/** Dispatch's logo, the Dock icon's blocks and its white-centred dot: the blocks drop in (design/icon-motion's 落块,
 *  base/common/dispatchIcon.ts) and the dot shows when the last one has landed, then its glow breathes. */
function dispatchMark(): { mark: HTMLElement; play(): void } {
	const mark = $('.dispatch-mark');
	mark.setAttribute('aria-hidden', 'true');
	ensureDispatchPalette();
	const svg = mark.appendChild(dispatchIconElement(MARK_SIZE, { ghosts: true, tight: true, mark: true }));
	const still = () => !!mark.closest('.monaco-reduce-motion') || getWindow(mark).matchMedia('(prefers-reduced-motion: reduce)').matches;
	const drop = dispatchIconDrop(svg, still, { onFormed: () => mark.classList.add('lit') });
	drop.hideAll();
	let played = false;
	return {
		mark,
		play: () => {
			if (!played) {
				played = true;
				drop.drop(DISPATCH_ICON_DROP.order);
			}
		},
	};
}

/** Puts the icon in place of the watermark's letterpress. The drop plays when the page is in front: held while
 *  the window is hidden (a window opened in the background would otherwise have finished it before anyone
 *  looked), then it runs. */
export function installDispatchMark(container: HTMLElement, root: HTMLElement): IDisposable {
	const { mark, play } = dispatchMark();
	root.querySelector('.letterpress')?.replaceWith(mark);
	const win = getWindow(container);
	const syncPlay = () => {
		if (win.document.visibilityState === 'visible') {
			play();
		}
	};
	syncPlay();
	return addDisposableListener(win.document, 'visibilitychange', syncPlay);
}
