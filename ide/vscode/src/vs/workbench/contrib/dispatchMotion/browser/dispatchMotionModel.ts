/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Settings › Appearance › Motion, its four choices and the two settings behind them (patches/
 *  055-motion-setting.patch). VS Code's own `workbench.reduceMotion` stops all motion (on) or none
 *  (off) or follows the Mac (auto); `dispatch.motion` adds Less: the Mac's way, with Dispatch's decoration stopped.
 *--------------------------------------------------------------------------------------------*/

export type MotionChoice = 'auto' | 'full' | 'less' | 'none';
export type ReduceMotion = 'auto' | 'on' | 'off';

export const DISPATCH_MOTION_SETTING = 'dispatch.motion';

/** What the two settings say together. */
export function motionChoice(reduce: string | undefined, dispatchMotion: string | undefined): MotionChoice {
	if (reduce === 'on') {
		return 'none';
	}
	if (dispatchMotion === 'less') {
		return 'less';
	}
	return reduce === 'off' ? 'full' : 'auto';
}

/**
 * The two settings for a choice. Less follows the Mac (auto), so the Mac's own Reduce motion still turns it all off
 * (DESIGN.md: prefers-reduced-motion stops everything); Full is motion even when the Mac reduces it.
 */
export function motionSettings(choice: MotionChoice): { readonly reduce: ReduceMotion; readonly dispatchMotion: 'full' | 'less' } {
	switch (choice) {
		case 'none': return { reduce: 'on', dispatchMotion: 'full' };
		case 'full': return { reduce: 'off', dispatchMotion: 'full' };
		case 'less': return { reduce: 'auto', dispatchMotion: 'less' };
		default: return { reduce: 'auto', dispatchMotion: 'full' };
	}
}
