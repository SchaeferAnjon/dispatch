/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the editor window's Keyboard Shortcuts lists the Agents window terminal's keys (patches/
 *  610-terminal.patch, task-lh6dx). Their names and default keys only: they act in the Agents
 *  window's terminal (dispatchTerminalFocus is never set here), so they stay out of this window's command palette. A
 *  key changed or removed here goes into keybindings.json, which the Agents window reads too.
 *--------------------------------------------------------------------------------------------*/

import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeybindingsRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { DISPATCH_TERMINAL_CATEGORY, DISPATCH_TERMINAL_KEY_WEIGHT, DISPATCH_TERMINAL_KEYS, terminalKeyCommand, terminalKeyWhen } from '../common/dispatchTerminalKeys.js';

for (const key of DISPATCH_TERMINAL_KEYS) {
	const id = terminalKeyCommand(key.name);
	MenuRegistry.addCommand({ id, title: key.title, category: DISPATCH_TERMINAL_CATEGORY });
	MenuRegistry.appendMenuItem(MenuId.CommandPalette, { command: { id, title: key.title }, when: ContextKeyExpr.false() });
	KeybindingsRegistry.registerKeybindingRule({
		id,
		primary: key.primary,
		secondary: key.secondary,
		when: terminalKeyWhen(key),
		weight: DISPATCH_TERMINAL_KEY_WEIGHT,
	});
}
