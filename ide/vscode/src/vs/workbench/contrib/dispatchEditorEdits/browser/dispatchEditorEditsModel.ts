/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: which edits of a text model are a person typing (dispatchEditorEdits.contribution.ts, task-m6hek).
 *  Pure, so ide/tests/editor-edits.test.mjs can load it on its own.
 *--------------------------------------------------------------------------------------------*/

/** Edit sources (TextModelEditSource's `source`) that are a person at the keyboard: typing, pasting, cutting, an
 *  editor command (delete line, move line), a snippet, a suggestion or a Tab completion they took, a rename or a
 *  quick fix they picked. */
const BY_HAND = new Set(['cursor', 'snippet', 'suggest', 'rename', 'codeAction', 'inlineCompletionAccept', 'inlineCompletionPartialAccept']);
/** An agent writing into the open file through the editor (the chat's or ⌘K's edits). */
const BY_AGENT = new Set(['Chat.applyEdits', 'inlineChat.applyEdits']);

export interface IEditFacts {
	/** the `source` of each of the event's detailed reasons */
	readonly sources: readonly string[];
	readonly isUndoing: boolean;
	readonly isRedoing: boolean;
	/** the model was set to new content (loaded or reloaded from disk) */
	readonly isFlush: boolean;
}

/** What one content change of a file's model says: a person changed it, an agent did, both, or neither (a reload
 *  from disk, an extension's edit, an end-of-line change: nobody the editor can vouch for). */
export function editKinds(f: IEditFacts): { hand: boolean; agent: boolean } {
	if (f.isFlush) {
		return { hand: false, agent: false };
	}
	const agent = f.sources.some(s => BY_AGENT.has(s));
	const hand = f.sources.some(s => BY_HAND.has(s)) || ((f.isUndoing || f.isRedoing) && !agent);
	return { hand, agent };
}
