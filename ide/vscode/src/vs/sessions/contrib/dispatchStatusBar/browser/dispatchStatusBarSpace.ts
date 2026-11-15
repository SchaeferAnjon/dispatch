/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: how tall the Agents window's bottom bar is (patches/120-status-bar.patch).
 *  The workbench leaves this much below its grid; the bar sets it when it shows (dispatchStatusBar.contribution.ts).
 *--------------------------------------------------------------------------------------------*/

let height = 0;

/** The bottom bar's height in pixels, 0 when there is none. */
export function dispatchStatusBarHeight(): number {
	return height;
}

export function setDispatchStatusBarHeight(value: number): void {
	height = Math.max(0, Math.round(value));
}
