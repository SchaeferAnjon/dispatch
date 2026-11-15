/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the command palette over a modal editor (patches/075-modal-palette.patch,
 *  task-oprqa). Since 1.139 Settings, Keyboard Shortcuts and the like open as a modal over the window, and the modal
 *  stops every workbench.* key that is not on its list (parts/editor/modalEditorPart.ts), so F1 and ⇧⌘P did nothing
 *  until Escape closed it. The palette goes on that list: what it runs is up to the person, as anywhere else.
 *--------------------------------------------------------------------------------------------*/

import { defaultModalEditorAllowableCommands } from '../../../browser/parts/editor/modalEditorPart.js';
import { MODAL_PALETTE_COMMANDS } from '../common/dispatchModalPalette.js';

for (const id of MODAL_PALETTE_COMMANDS) {
	defaultModalEditorAllowableCommands.add(id);
}
