/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the changes pill above a side chat's input counts what that chat changed itself. It showed the
 *  session's total (the main chat's edits, "2 Files +116 -2") under a side chat that had changed nothing
 *  (kanban, 2026-10-10). A file changed in several turns counts once.
 *--------------------------------------------------------------------------------------------*/

/** One file a turn changed: its identity and its line counts. */
export interface IChatTurnFileChange {
	readonly modifiedURI: { toString(): string };
	readonly added: number;
	readonly removed: number;
}

export interface IChatOwnChangesStats {
	readonly files: number;
	readonly insertions: number;
	readonly deletions: number;
}

/** The changes of a chat's turns (oldest first) added up: each file once, its lines in every turn. */
export function sumChatOwnChanges(turns: readonly (readonly IChatTurnFileChange[])[]): IChatOwnChangesStats {
	const files = new Set<string>();
	let insertions = 0, deletions = 0;
	for (const turn of turns) {
		for (const change of turn) {
			files.add(change.modifiedURI.toString());
			insertions += change.added;
			deletions += change.removed;
		}
	}
	return { files: files.size, insertions, deletions };
}
