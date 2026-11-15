/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: which files of a repository's session diff belong to the session.
 *
 *  The session changeset is the git diff between the session's first checkpoint and its latest turn checkpoint.
 *  Two sessions in one repository share the working tree, so the diff listed what the other session (and the person)
 *  changed in between too (kanban, 2026-10-11: an Assistant session's Changes listed files another session had edited).
 *  Claude and Copilot record every file they edit (the session database's `file_edits`, sub-agents and side chats
 *  included); that record is the list. OpenCode and Codex record none, so their list is what changed inside their own
 *  turns (each turn's start checkpoint to its end checkpoint).
 *--------------------------------------------------------------------------------------------*/

import { extUriBiasedIgnorePathCase } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { CLAUDE_AGENT_PROVIDER_ID, CODEX_AGENT_PROVIDER_ID } from '../common/agent.js';
import type { IFileEditRecord } from '../common/sessionDataService.js';
import type { ISessionFileDiff } from '../common/state/sessionState.js';

/** Engines that write `file_edits` for everything they (and their sub-agents) edit. 'copilotcli' is Copilot's provider id. */
const EDIT_RECORD_PROVIDERS: ReadonlySet<string> = new Set([CLAUDE_AGENT_PROVIDER_ID, 'copilotcli']);

export function recordsFileEdits(provider: string | undefined): boolean {
	return provider !== undefined && EDIT_RECORD_PROVIDERS.has(provider);
}

/** Engines with no edit record: OpenCode ('opencode', node/opencode) and Codex. */
const TURN_WINDOW_PROVIDERS: ReadonlySet<string> = new Set(['opencode', CODEX_AGENT_PROVIDER_ID]);

export function listsOnlyOwnTurns(provider: string | undefined): boolean {
	return provider !== undefined && TURN_WINDOW_PROVIDERS.has(provider);
}

/** Key two spellings of one file agree on: the file URI string and the OS path of the edit record, by the platform's casing. */
export function fileKey(uriOrPath: string): string {
	const uri = uriOrPath.includes('://') || uriOrPath.startsWith('file:') ? URI.parse(uriOrPath) : URI.file(uriOrPath);
	return extUriBiasedIgnorePathCase.getComparisonKey(uri);
}

/** Every file the edit records touched, a rename's old path too. */
export function editedFileKeys(edits: readonly IFileEditRecord[]): Set<string> {
	const keys = new Set<string>();
	for (const edit of edits) {
		keys.add(fileKey(edit.filePath));
		if (edit.originalPath) {
			keys.add(fileKey(edit.originalPath));
		}
	}
	return keys;
}

/** The files a diff list names (before and after of each entry). */
export function diffFileKeys(diffs: readonly ISessionFileDiff[]): Set<string> {
	const keys = new Set<string>();
	for (const diff of diffs) {
		for (const uri of [diff.before?.uri, diff.after?.uri]) {
			if (uri) {
				keys.add(fileKey(uri));
			}
		}
	}
	return keys;
}

/** The entries that name at least one file in `keys`. */
export function keepDiffsOfFiles(diffs: readonly ISessionFileDiff[], keys: ReadonlySet<string>): ISessionFileDiff[] {
	return diffs.filter(diff => [diff.before?.uri, diff.after?.uri].some(uri => uri !== undefined && keys.has(fileKey(uri))));
}
