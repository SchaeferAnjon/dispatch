/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: what a finished reply folds away (task-hlkrw).
 *--------------------------------------------------------------------------------------------*/

/**
 * A finished reply folds its steps under one "Completed N steps" line. VS Code folded everything before the
 * last run of text, so a long answer followed by a few more tools and one short line ended up behind the fold
 * with only that line showing. What the agent wrote to the person stays outside now, in order: this returns the
 * runs of steps between those texts. Each run folds on its own, and the one line opens and closes them all.
 */
export function splitCompletedResponseSteps<T>(nodes: readonly T[], isText: (node: T) => boolean): T[][] {
	const runs: T[][] = [];
	let run: T[] = [];
	for (const node of nodes) {
		if (!isText(node)) {
			run.push(node);
		} else if (run.length) {
			runs.push(run);
			run = [];
		}
	}
	if (run.length) {
		runs.push(run);
	}
	return runs;
}

/** Text written to the person: a markdown part with words in it, not one that is only white space. */
export function isTextForPerson(markdown: string): boolean {
	return markdown.trim().length > 0;
}
