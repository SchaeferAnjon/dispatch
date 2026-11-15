/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: where the Settings page is (the page on screen, the search typed), shared by the contents in
 *  the side bar (dispatchSettingsNav.ts) and the page in the middle (dispatchSettingsView.ts).
 *--------------------------------------------------------------------------------------------*/

import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { SettingsPageId } from './dispatchSettingsModel.js';

export const DISPATCH_SETTINGS_VIEW_ID = 'dispatch.settings';
export const DISPATCH_SETTINGS_OPEN = 'dispatch.settings.open';
export const DISPATCH_SETTINGS_CLOSE = 'dispatch.settings.close';

export interface ISettingsLocation {
	readonly page: SettingsPageId;
	readonly query: string;
	/** The row to flash once the page is drawn (its data-setting). */
	readonly flash?: string;
	/** Goes up on every change, so the same page asked for again still redraws and flashes. */
	readonly seq: number;
}

const location = observableValue<ISettingsLocation>('dispatchSettingsLocation', { page: 'overview', query: '', seq: 0 });
export const settingsLocation: IObservable<ISettingsLocation> = location;

const open = observableValue<boolean>('dispatchSettingsOpen', false);
/** The Settings page is the one shown in the middle of the window. */
export const settingsOpen: IObservable<boolean> = open;

let seq = 0;

/** Pages that live elsewhere: Tab completion and ⌘K are in the editor window's own Settings (dispatchSettingsEditorLink.ts). */
export const settingsElsewhere: { editor?: () => void } = {};

export function goToSettingsPage(page: SettingsPageId, flash?: string): void {
	if (page === 'editor' && settingsElsewhere.editor) {
		settingsElsewhere.editor();
		return;
	}
	location.set({ page, query: '', flash, seq: ++seq }, undefined);
}

export function setSettingsQuery(query: string): void {
	const cur = location.get();
	if (cur.query !== query) {
		location.set({ page: cur.page, query, seq: ++seq }, undefined);
	}
}

export function setSettingsOpen(value: boolean): void {
	open.set(value, undefined);
}

const ESCAPE_MS = 500;
let escapeAt = 0;
let escapeHadPopup = false;

/** Called first on every Escape (a capture listener on the window): was a popup (a hover card, the phone's pairing
 *  panel, a menu) open when it was pressed? Then that Escape closes the popup, not Settings. */
export function noteEscape(hadPopup: boolean): void {
	escapeHadPopup = hadPopup;
	escapeAt = hadPopup ? Date.now() : 0;
}

/** Only the Escape being handled right now: an earlier one that closed a menu must not swallow the next Close (the
 *  Back row's click ran the same command and did nothing, 10-08 slash-menu). */
export function escapeWasForAPopup(): boolean {
	return escapeHadPopup && Date.now() - escapeAt < ESCAPE_MS;
}
