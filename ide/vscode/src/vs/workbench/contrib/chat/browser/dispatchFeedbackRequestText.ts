/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the turn Submit Feedback sends shows the notes you wrote, not `/act-on-feedback`
 *  (patches/220-opencode.patch, task-et0q). The request's own text stays the slash command, which the
 *  agents need (Claude and Copilot run the act-on-feedback skill, OpenCode's harness reads the notes); only what
 *  the chat, the prompts list, find and screen readers show is the notes. No imports, so
 *  tests/feedback-text.test.mjs runs it as it is.
 *--------------------------------------------------------------------------------------------*/

const ACT_ON_FEEDBACK = /^\s*\/act-on-feedback\b(?:\s+for\s+#\d+)?\s*/;

interface IFeedbackLike {
	readonly kind?: string;
	readonly feedbackItems?: readonly { readonly text?: string }[];
}

/**
 * What to show for a request whose text is `/act-on-feedback`: the notes it carries, one a line, then anything typed
 * after the command; `fallback` when the notes are not there (a turn read back from an agent's history). Undefined
 * for every other request, which keeps its own text.
 */
export function feedbackRequestText(messageText: string, variables: readonly unknown[] | undefined, fallback: string): string | undefined {
	if (!ACT_ON_FEEDBACK.test(messageText)) {
		return undefined;
	}
	const rest = messageText.replace(ACT_ON_FEEDBACK, '').trim();
	const notes: string[] = [];
	for (const v of variables ?? []) {
		const entry = v as IFeedbackLike;
		if (entry?.kind === 'agentFeedback') {
			for (const item of entry.feedbackItems ?? []) {
				const t = (item?.text ?? '').trim();
				if (t) {
					notes.push(t);
				}
			}
		}
	}
	const lines = [...notes, ...(rest ? [rest] : [])];
	return lines.length ? lines.join('\n\n') : fallback;
}
