/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the commands a modal editor lets through on top of VS Code's own list
 *  (patches/075-modal-palette.patch): F1 and ⇧⌘P, the command palette.
 *--------------------------------------------------------------------------------------------*/

export const MODAL_PALETTE_COMMANDS: readonly string[] = ['workbench.action.showCommands'];
