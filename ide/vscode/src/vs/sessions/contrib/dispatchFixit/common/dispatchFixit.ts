/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: when a commit, a push or a merge from the Changes tab goes wrong, the tab says what
 *  happened in plain words and offers one button, "Let the agent fix it"; the commit message is
 *  written by the default agent (kanban app/cli/fixit.py: `dispatch fix …`, `dispatch write …`).
 *
 *  The agent host's changeset operations reach this through one hook in AgentHostSessionChangesets
 *  (`dispatchChangesetHooks`), so the native files only gain a few lines.
 *--------------------------------------------------------------------------------------------*/

/** The commit message the default agent wrote, handed to the agent host's commit and merge handlers. */
export const DISPATCH_COMMIT_MESSAGE_META = 'dispatch.commitMessage';

export interface IDispatchChangesetHooks {
	/** Before an operation runs: may add the agent-written commit message to its `_meta`. */
	before(operationId: string, meta: Record<string, unknown> | undefined): Promise<Record<string, unknown> | undefined>;
	/** After it succeeded. */
	succeeded(operationId: string): void;
	/** It failed: true when the Changes tab took it over (it shows the card, so no raw error is raised). */
	failed(operationId: string, error: unknown): boolean;
}

export const dispatchChangesetHooks: { current: IDispatchChangesetHooks | undefined } = { current: undefined };

/** One thing that is wrong, as `dispatch fix` describes it. */
export interface IDispatchProblem {
	readonly kind: 'commit' | 'push' | 'conflicts' | 'checks' | 'comments';
	readonly problem: boolean;
	readonly title: string;
	readonly explain: string;
	readonly details?: string;
	readonly fixable?: boolean;
	readonly action?: string;
	readonly prompt?: string;
	readonly files?: readonly string[];
	readonly key: string;
	/** Where the project was when it went wrong (a failed commit, push or merge): `dispatch fix settled --since`. */
	readonly head?: string;
	/** What the problem said was missing: 'identity' when git did not know the person's name and email. */
	readonly need?: string;
}

/** What `dispatch fix settled` answered: the failed commit, push or merge is behind us (task-mrdg). */
export interface IDispatchSettled {
	readonly settled?: boolean;
	/** committed / sent end the matter; clean: nothing left to commit; ready: fixed, the person can press it again. */
	readonly how?: 'committed' | 'sent' | 'clean' | 'ready' | '';
	readonly subject?: string;
}

/** What `dispatch write commit-message` answered. */
export interface IDispatchWritten {
	readonly text?: string;
	readonly subject?: string;
	readonly ai?: boolean;
	readonly by?: string;
	readonly by_label?: string;
	readonly reason?: string;
	readonly error?: string;
}

/** Which kind of problem a failed operation is, or undefined when the Changes tab leaves it alone. */
export function failureKind(operationId: string, message: string): 'commit' | 'push' | 'conflicts' | undefined {
	switch (operationId) {
		case 'commit':
			return 'commit';
		case 'sync':
			return /conflict|could not apply|needs merge|unmerged/i.test(message) ? 'conflicts' : 'push';
		case 'merge':
			// merging into the main branch stops (and is undone) when both sides changed the same lines
			if (/conflict|Failed to merge changes into|merging into '[^']*' failed/i.test(message)) {
				return 'conflicts';
			}
			// a merge commits what is uncommitted first; when that commit is refused it is a failed commit
			return /^Failed to commit changes/i.test(message) ? 'commit' : undefined;
		default:
			return undefined;
	}
}

/** The operations whose commit message an agent writes. */
export function writesCommitMessage(operationId: string): boolean {
	return operationId === 'commit' || operationId === 'merge';
}
