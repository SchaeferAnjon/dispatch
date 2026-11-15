/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: which `result` ends the prompt we sent. Claude Code also runs turns nobody sent: resuming a forked
 *  conversation whose source had background agents running, it first queues "N background agents didn't finish
 *  before the previous session ended" (a task notification) and ends that with a `result` of its own, before the
 *  one for our prompt. The pipeline settled our prompt on it, so the reply that followed had no turn to go to and the
 *  side chat showed an empty answer (kanban, 2026-10-10). Such a result says what started it in `origin`
 *  (`{ kind: 'task-notification' }`, CLI 2.1.296); a result for a prompt we sent has no origin, or `human`.
 *--------------------------------------------------------------------------------------------*/

/** The field of an SDK result message that says what started its turn. */
export interface IResultProvenance {
	readonly origin?: { readonly kind: string } | null;
}

/** Whether `result` ends a turn started by a prompt we sent rather than one the CLI started itself. */
export function isResultForSentPrompt(result: IResultProvenance): boolean {
	return !result.origin || result.origin.kind === 'human';
}
