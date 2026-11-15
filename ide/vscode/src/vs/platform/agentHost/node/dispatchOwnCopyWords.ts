/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: what a session says about its own copy (patches/295-own-copy.patch, kanban task-lj06.16), in
 *  plain words: no "worktree", no "merge conflict". Pure functions, no imports, so tests/own-copy.test.mjs runs
 *  them as they are.
 *--------------------------------------------------------------------------------------------*/

/** What `dispatch worktree land` answers (kanban app/cli/own_copy.py). */
export interface ILand {
	readonly ok?: boolean;
	readonly state?: 'landed' | 'nothing' | 'conflict' | 'folder_changes' | 'folder_busy' | 'other_branch' | 'manual' | 'not_copy' | 'error';
	readonly main?: string;
	readonly branch?: string;
	readonly into?: string;
	readonly files?: readonly string[];
	readonly ahead?: number;
	readonly dirty?: boolean;
	readonly folder_branch?: string;
	readonly message?: string;
}

export type QuestionKind = 'conflict' | 'folder_changes' | 'other_branch' | 'waited';

export interface IOwnCopyQuestion {
	readonly title: string;
	readonly message: string;
	readonly options: readonly { readonly id: string; readonly label: string; readonly description: string; readonly recommended?: boolean }[];
}

/**
 * Whether a session's first message decides folder or copy (dispatchOwnCopy.ts beforeFirstSend): only a folder
 * session that has not run a turn. A session the person switched to Separate copy after it was made (held back as
 * a folder session, Separate copy now) keeps that choice: the worktree path makes its copy (task-lj06.27).
 */
export function firstMessageDecides(o: { readonly deferred: boolean; readonly pending: boolean; readonly isolation: unknown; readonly hasTurns: boolean }): boolean {
	if (o.isolation === 'worktree') {
		return false;
	}
	return o.deferred || (!o.pending && !o.hasTurns);
}

/** A file: URI or a path as a path. */
export function fsPath(uri: string | undefined): string | undefined {
	if (!uri) {
		return undefined;
	}
	if (uri.startsWith('file://')) {
		try {
			return decodeURIComponent(new globalThis.URL(uri).pathname);
		} catch {
			return undefined;
		}
	}
	return uri.startsWith('/') ? uri : undefined;
}

export function folderName(path: string | undefined): string {
	return (path || '').replace(/\/+$/, '').split('/').pop() || 'the project folder';
}

/** "index.html", "index.html and app.js", "a, b, c and 4 more". */
export function fileList(files: readonly string[] | undefined): string {
	const all = (files || []).filter(Boolean);
	if (!all.length) {
		return '';
	}
	const shown = all.slice(0, 3);
	const rest = all.length - shown.length;
	if (rest > 0) {
		return `${shown.join(', ')} and ${rest} more`;
	}
	return shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/** Said in the session when it takes a copy of its own. */
export function copyNotice(folder: string): string {
	const name = folderName(folder);
	return `Another agent is working in ${name} right now, so this session works in a separate copy. Its changes go into ${name} by themselves when it is done.`;
}

/** Said once while the folder is busy and the changes wait. */
export function waitNotice(r: ILand): string {
	return `${folderName(r.main)} is busy with ${fileList(r.files) || 'other changes'} right now. This session's changes go in as soon as it is free.`;
}

/** The words of a land result the person reads in the session, or undefined when nothing needs saying. */
export function landNotice(r: ILand): string | undefined {
	const folder = folderName(r.main);
	switch (r.state) {
		case 'landed':
			return r.files?.length
				? `This session's changes are in ${folder} now: ${fileList(r.files)}.`
				: `This session's changes are in ${folder} now.`;
		case 'manual':
			return (r.ahead || r.dirty)
				? `These changes are in a separate copy, not in ${folder} yet. Merge Changes at the top of the window puts them there.`
				: undefined;
		case 'error':
			return `This session's changes are still in its own copy: Dispatch could not put them into ${folder}. ${r.message || ''}`.trim();
		default:
			return undefined;
	}
}

/** The question card when the changes could not go in by themselves. */
export function question(kind: QuestionKind, r: ILand): IOwnCopyQuestion {
	const folder = folderName(r.main);
	const files = fileList(r.files);
	const keep = { id: 'keep', label: 'Keep them in the copy for now', description: `Nothing changes in ${folder}. Merge Changes at the top of the window brings them in later.` };
	switch (kind) {
		case 'conflict':
			return {
				title: 'Changes overlap',
				message: `This session worked in its own copy because another agent was working in ${folder}. Both changed ${files || 'the same lines'}, so Dispatch did not put this session's changes into ${folder}.`,
				options: [{ id: 'combine', label: 'Let the agent combine them', description: 'It brings in what changed in the folder, keeps what both changes are for, and Dispatch tries again.', recommended: true }, keep],
			};
		case 'folder_changes':
			return {
				title: 'Changes not in the folder yet',
				message: `${folder} has changes nobody saved yet in ${files || 'the same files'}, and this session changed them too, so Dispatch did not put its changes in.`,
				options: [{ id: 'retry', label: 'Try again', description: 'After you saved or put away those changes.' }, keep],
			};
		case 'other_branch':
			return {
				title: 'Changes not in the folder yet',
				message: `${folder} is on the branch ${r.folder_branch} now, not ${r.into} where this session started, so Dispatch did not put its changes in.`,
				options: [{ id: 'here', label: `Put them into ${r.folder_branch}`, description: `The branch ${folder} is on now.` }, keep],
			};
		default:
			return {
				title: 'Changes not in the folder yet',
				message: `${folder} stayed busy, so this session's changes are still in its own copy.`,
				options: [{ id: 'retry', label: 'Try again', description: `When ${folder} is free.` }, keep],
			};
	}
}

/** The prompt that asks the agent to combine its copy with what is in the folder now. */
export function combinePrompt(r: ILand): string {
	const folder = folderName(r.main);
	return `While you worked in your own copy, ${folder} changed too, and both changed ${fileList(r.files) || 'the same lines'}. `
		+ `Bring those changes into your copy (git merge ${r.into || 'the branch of the project folder'}), keep what both changes are for, finish the merge with a commit, and say in a sentence what you combined. `
		+ `Dispatch puts your work into ${folder} after that.`;
}
