/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Agents window terminal's keys that are yours to change (patches/610-terminal.patch,
 *  task-lh6dx). Orca's keys are the defaults: split, close and move between panes, enlarge one, the folder's next and
 *  previous session, the text size. One list for both windows: the Agents window runs them
 *  (sessions/contrib/dispatchTerminal/browser/dispatchTerminalActions.ts); the editor window only knows their names
 *  and keys (../browser/dispatchTerminalKeys.contribution.ts), so its Keyboard Shortcuts lists them and a change made
 *  there (the person's keybindings.json, shared by both windows) reaches the terminal.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../nls.js';
import { ILocalizedString } from '../../../../platform/action/common/action.js';
import { ContextKeyExpr, ContextKeyExpression } from '../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';

export type DispatchTerminalKeyName = 'splitRight' | 'splitDown' | 'closePane' | 'nextPane' | 'previousPane' | 'expandPane' | 'nextSession' | 'previousSession' | 'zoomIn' | 'zoomOut' | 'zoomReset';

export interface IDispatchTerminalKey {
	readonly name: DispatchTerminalKeyName;
	readonly title: ILocalizedString;
	readonly primary: number;
	readonly secondary?: number[];
	/** Only in a pane split off a session: ⌘W elsewhere stays the window's (closing the first pane is Close Terminal). */
	readonly paneOnly?: boolean;
}

export const DISPATCH_TERMINAL_KEYS: readonly IDispatchTerminalKey[] = [
	{ name: 'splitRight', title: localize2('dispatchTerminalKeys.splitRight', "Split Terminal Right"), primary: KeyMod.CtrlCmd | KeyCode.KeyD },
	{ name: 'splitDown', title: localize2('dispatchTerminalKeys.splitDown', "Split Terminal Down"), primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyD },
	{ name: 'closePane', title: localize2('dispatchTerminalKeys.closePane', "Close Terminal Pane"), primary: KeyMod.CtrlCmd | KeyCode.KeyW, paneOnly: true },
	{ name: 'nextPane', title: localize2('dispatchTerminalKeys.nextPane', "Go to Next Terminal Pane"), primary: KeyMod.CtrlCmd | KeyCode.BracketRight },
	{ name: 'previousPane', title: localize2('dispatchTerminalKeys.previousPane', "Go to Previous Terminal Pane"), primary: KeyMod.CtrlCmd | KeyCode.BracketLeft },
	{ name: 'expandPane', title: localize2('dispatchTerminalKeys.expandPane', "Expand or Restore Terminal Pane"), primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Enter },
	{ name: 'nextSession', title: localize2('dispatchTerminalKeys.nextSession', "Go to Next Session in This Folder"), primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.BracketRight },
	{ name: 'previousSession', title: localize2('dispatchTerminalKeys.previousSession', "Go to Previous Session in This Folder"), primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.BracketLeft },
	{ name: 'zoomIn', title: localize2('dispatchTerminalKeys.zoomIn', "Make the Terminal Text Bigger"), primary: KeyMod.CtrlCmd | KeyCode.Equal, secondary: [KeyMod.CtrlCmd | KeyCode.NumpadAdd] },
	{ name: 'zoomOut', title: localize2('dispatchTerminalKeys.zoomOut', "Make the Terminal Text Smaller"), primary: KeyMod.CtrlCmd | KeyCode.Minus, secondary: [KeyMod.CtrlCmd | KeyCode.NumpadSubtract] },
	{ name: 'zoomReset', title: localize2('dispatchTerminalKeys.zoomReset', "Reset the Terminal Text Size"), primary: KeyMod.CtrlCmd | KeyCode.Digit0, secondary: [KeyMod.CtrlCmd | KeyCode.Numpad0] },
];

/** In Keyboard Shortcuts and the command palette: "Agents Terminal: Split Terminal Right". */
export const DISPATCH_TERMINAL_CATEGORY = localize2('dispatchTerminalKeys.category', "Agents Terminal");
export const DISPATCH_TERMINAL_KEY_WEIGHT = KeybindingWeight.WorkbenchContrib + 60;
/** What Keyboard Shortcuts is searched for to list only these. */
export const DISPATCH_TERMINAL_KEYS_QUERY = 'dispatch.terminal.';

export function terminalKeyCommand(name: DispatchTerminalKeyName): string {
	return `dispatch.terminal.${name}`;
}

/** The keyboard is in a terminal session of the Agents window (dispatchTerminalFocus), in a split-off pane for ⌘W. */
export function terminalKeyWhen(key: IDispatchTerminalKey): ContextKeyExpression {
	const focus = ContextKeyExpr.has('dispatchTerminalFocus');
	return key.paneOnly ? ContextKeyExpr.and(focus, ContextKeyExpr.has('dispatchTerminalInPane'))! : focus;
}
