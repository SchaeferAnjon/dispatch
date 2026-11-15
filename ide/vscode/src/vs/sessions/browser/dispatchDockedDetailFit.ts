/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: how the docked detail (the Files tab's file list, the Changes tab's list) shares the side pane
 *  with the editor content (kanban, user 2026-10-10: in a ~400 px side pane the Files tab was a 100 px strip of
 *  "Select a file from the Files view" cut to "elect a file fro" beside the file tree).
 *
 *  - No file open (the Files tab's placeholder): there is nothing to show beside the list, so the list takes the
 *    whole pane.
 *  - The Changes tab of a session with no changed files: the diff beside the list would say "No Changed Files" next
 *    to the list's own "Changes / No changed files", two blocks saying one thing (user 2026-10-10, task-wwi8s: "我点击
 *    changes之后 会出现两个changes"). The list takes the whole pane, under the Changes header, until a file changes.
 *  - A pane narrower than the list's and the editor's minimum widths together (220 + 300): one at a time, the way a
 *    VS Code side bar snaps closed when there is no room for it. Opening a file (or switching to a tab with
 *    content) shows the file and folds the list away; Toggle File List (⌥⌘L) brings the list back over the whole
 *    pane, and opening a file from it folds it again. Dragged wide again, a list folded away for room comes back.
 *--------------------------------------------------------------------------------------------*/

import { RawContextKey } from '../../platform/contextkey/common/contextkey.js';
import { EditorInput } from '../../workbench/common/editor/editorInput.js';

/** The Files tab's placeholder (contrib/editor's EmptyFileEditorInput.ID; by id, so this layer does not import it). */
const EMPTY_FILE_TYPE_ID = 'workbench.editors.agentSessions.emptyFile';
/** The Changes tab (contrib/changes' SessionChangesEditorInput.ID). */
const SESSION_CHANGES_TYPE_ID = 'workbench.input.agentSessions.sessionChanges';

/** The active session has loaded its changes and there are none (contrib/changes/browser/dispatchChangesEmpty.ts). */
export const DispatchNoChangesContext = new RawContextKey<boolean>('dispatchSessionNoChanges', false);

/** Below this the list and the editor content do not both fit (DockedAuxiliaryBarController MIN_WIDTH + EDITOR_MIN_WIDTH). */
export const DISPATCH_SIDE_BY_SIDE_MIN_WIDTH = 520;

export interface IDispatchDockedDetailHost {
	isEditorVisible(): boolean;
	isAuxiliaryBarVisible(): boolean;
	setAuxiliaryBarHidden(hidden: boolean): void;
	activeEditor(): EditorInput | undefined;
	/** The tab in front has a detail to show (Changes, Files, a file): not Docs, Tasks or a browser page. */
	hasDockedDetails(): boolean;
	/** The active session's changes are loaded and there are none ({@link DispatchNoChangesContext}). */
	hasNoChanges?(): boolean;
}

export function isDispatchFilesPlaceholder(editor: EditorInput | undefined | null): boolean {
	return !editor || editor.typeId === EMPTY_FILE_TYPE_ID;
}

/** Nothing for the editor to show beside the list: the Files placeholder, or the Changes tab with no changes. */
export function isDispatchNothingBeside(editor: EditorInput | undefined | null, noChanges: boolean): boolean {
	return isDispatchFilesPlaceholder(editor) || (noChanges && editor?.typeId === SESSION_CHANGES_TYPE_ID);
}

export class DispatchDockedDetailFit {

	private _narrow = false;
	/** The list was folded away for room (not by the person): it comes back when the pane is wide enough again. */
	private _folded = false;
	/** A fold asked for and not done yet (the layouts in between still see the list). */
	private _folding = false;

	constructor(private readonly host: IDispatchDockedDetailHost) { }

	/** Called on every layout of the docked detail: whether it takes the whole pane. */
	fills(paneWidth: number): boolean {
		const narrow = paneWidth > 0 && paneWidth < DISPATCH_SIDE_BY_SIDE_MIN_WIDTH;
		const placeholder = isDispatchNothingBeside(this.host.activeEditor(), this.host.hasNoChanges?.() === true);
		const wasNarrow = this._narrow;
		this._narrow = narrow;
		if (this.host.isAuxiliaryBarVisible() && !this._folding) {
			// shown again (the toggle, the Files tab): no longer folded away for room
			this._folded = false;
		}
		if (narrow && !wasNarrow && !placeholder) {
			// dragged narrow with a file in front: the file stays, the list folds away
			this.fold();
		} else if (!narrow && this._folded && this.host.isEditorVisible() && !this.host.isAuxiliaryBarVisible() && this.host.hasDockedDetails()) {
			this._folded = false;
			setTimeout(() => this.host.setAuxiliaryBarHidden(false));
		}
		return placeholder || narrow;
	}

	/** A file (or a tab with content) is about to be shown: in a narrow pane it takes the pane from the list. */
	willShow(editor: EditorInput): void {
		if (this._narrow && !isDispatchNothingBeside(editor, this.host.hasNoChanges?.() === true)) {
			this.fold();
		}
	}

	private fold(): void {
		if (this.host.isEditorVisible() && this.host.isAuxiliaryBarVisible() && !this._folding) {
			this._folded = true;
			this._folding = true;
			setTimeout(() => {
				this._folding = false;
				this.host.setAuxiliaryBarHidden(true);
			});
		}
	}
}
