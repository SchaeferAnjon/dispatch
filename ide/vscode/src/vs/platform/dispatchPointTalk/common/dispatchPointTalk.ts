/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Point and talk's main-process side (direction A「Button by the input」, the person picked it
 *  2026-11-16, task-0y0km; kanban design/screen-talk). What the Agents window asks of the main process:
 *
 *  - which display to record: the one under the pointer when recording starts (no picker, no app to choose); the
 *    next getDisplayMedia of that window gets it (code/electron-main/app.ts asks takeDispatchPointTalkDisplay);
 *  - macOS's two permissions, read and asked for: the microphone with macOS's own dialog, Screen Recording in System
 *    Settings with a small panel that holds Dispatch's icon to drag into the list;
 *  - the bar at the top of the recorded display while Dispatch is not in sight there, and a moving red frame round
 *    that display for the whole recording: windows of their own that never take the focus and are left out of the
 *    recording;
 *  - ⌃⇧S anywhere: one system-wide shortcut that runs dispatch.pointTalk.toggle in the window that set it.
 *
 *  Test instances (DISPATCH_E2E_INSTANCE) never touch the screen, the microphone or System Settings and never take a
 *  shortcut from the person's own Dispatch: `access().test` tells the window to use its test sources.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const DISPATCH_POINT_TALK_CHANNEL = 'dispatchPointTalk';

export const IDispatchPointTalkMainService = createDecorator<IDispatchPointTalkMainService>('dispatchPointTalkMainService');

/** What macOS says about one permission (Electron's systemPreferences.getMediaAccessStatus). */
export type PointTalkAccessState = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

export interface IPointTalkAccess {
	readonly microphone: PointTalkAccessState;
	/** macOS only says granted or denied here: never asked looks the same as refused. */
	readonly screen: PointTalkAccessState;
	/** Screen Recording was turned on after Dispatch started: macOS wants it reopened before it records. */
	readonly relaunch: boolean;
	/** A test instance: no real screen, microphone or System Settings. */
	readonly test: boolean;
	/** Where recordings go: ~/.dispatch/recordings (DISPATCH_HOME/recordings in a test instance). */
	readonly recordings: string;
}

export interface IPointTalkRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** The display a recording takes, in screen points. */
export interface IPointTalkDisplay {
	readonly id: number;
	readonly bounds: IPointTalkRect;
	readonly scaleFactor: number;
}

export interface IPointTalkPrepared {
	readonly display: IPointTalkDisplay;
	/** The asking window is on that display (and not minimised): the input box shows the recording, no bar. */
	readonly windowOnDisplay: boolean;
}

/** The colours of the bar and the frame, from the window's theme. */
export interface IPointTalkTheme {
	readonly dark: boolean;
	readonly bg: string;
	readonly border: string;
	readonly text: string;
	readonly text2: string;
	readonly fill: string;
	readonly fillText: string;
	/** The recording red (errorForeground): the dot and the moving frame. */
	readonly red: string;
}

/** What the bar shows; sent again as it changes (the clock each second, the level a few times a second). */
export interface IPointTalkBarState {
	readonly clock: string;
	/** Five bar heights, 0 to 1. */
	readonly level: readonly number[];
	/** The words so far (the bar shows the end of them). */
	readonly words: string;
	/** The newest spot's number, 0 before the first. */
	readonly spot: number;
	/** The spot number changed: pop the dot once. */
	readonly popped: boolean;
}

export interface IDispatchPointTalkMainService {
	readonly _serviceBrand: undefined;

	access(): Promise<IPointTalkAccess>;
	/** macOS's microphone dialog (the first time; after that what was answered). */
	askMicrophone(): Promise<boolean>;
	/** Screen Recording: Dispatch into the list (macOS asks the first time), the pane opened, the drag panel shown. */
	openScreenSettings(windowId: number, theme: IPointTalkTheme): Promise<void>;
	/** The drag panel goes (granted, or the card closed). */
	closeScreenHelp(): Promise<void>;

	/** The display under the pointer: the next screen capture of `windowId` records it. */
	prepare(windowId: number): Promise<IPointTalkPrepared>;

	showBar(windowId: number, displayId: number, theme: IPointTalkTheme, state: IPointTalkBarState): Promise<void>;
	updateBar(state: IPointTalkBarState): Promise<void>;
	hideBar(): Promise<void>;
	/** The moving red frame round the recorded display, from start to stop; `ring` draws one ring where a spot was marked. */
	showFrame(displayId: number, theme: IPointTalkTheme): Promise<void>;
	ring(x: number, y: number): Promise<void>;
	hideFrame(): Promise<void>;

	/** The system-wide shortcut (an Electron accelerator, e.g. Control+Shift+S) that toggles recording in `windowId`;
	 *  undefined takes it away. False when macOS or another app has it, or in a test instance. */
	setShortcut(windowId: number, accelerator: string | undefined): Promise<boolean>;
}
