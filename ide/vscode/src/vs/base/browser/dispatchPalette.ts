/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the app icon's colours as CSS variables in the workbench (the values and their reasons are in
 *  base/common/dispatchPalette.ts).
 *--------------------------------------------------------------------------------------------*/

import { createStyleSheet } from './domStylesheets.js';
import { dispatchPaletteCss } from '../common/dispatchPalette.js';
import { dispatchIconBreathCss } from '../common/dispatchIcon.js';

let installed = false;

/**
 * Adds `--dispatch-icon-*` and `--dispatch-state-*` once, as a global stylesheet (auxiliary windows get a copy), with
 * the app icon's dot breath.
 * Every module whose CSS reads them calls it when it loads.
 */
export function ensureDispatchPalette(): void {
	if (installed) {
		return;
	}
	installed = true;
	createStyleSheet(undefined, style => {
		style.textContent = [
			dispatchPaletteCss(),
			// the app icon's running dot breathes wherever the icon is drawn (base/browser/dispatchIcon.ts), still when motion is reduced
			dispatchIconBreathCss('.dispatch-icon .now'),
			'.monaco-reduce-motion .dispatch-icon .now, .monaco-reduce-motion .dispatch-icon .now > .glow { animation: none; }',
		].join('\n');
	});
}
