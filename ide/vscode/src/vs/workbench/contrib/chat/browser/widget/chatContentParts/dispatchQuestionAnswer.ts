/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a question card is answered by what the person typed in the message box under it
 *  (360-question-answers.patch). No imports, so tests/question-answers.test.mjs runs it in node.
 *--------------------------------------------------------------------------------------------*/

/** The chat input under a question card: what was typed there, and a way to empty it once it answered. */
export interface IDispatchTypedAnswer {
	read(): string;
	clear(): void;
}

/**
 * What the person typed in the message box answers the question on screen, ahead of any option on the
 * card: Submit, Enter and ⌘⏎ all send it (they sent the card's first option and left the words behind,
 * task-lj06.15). A slash command is not an answer. True when the typed words answered the card.
 */
export function takeTypedAnswer(input: IDispatchTypedAnswer | undefined, answer: (text: string) => boolean): boolean {
	const typed = input?.read().trim() ?? '';
	if (!typed || typed.startsWith('/') || !answer(typed)) {
		return false;
	}
	input?.clear();
	return true;
}
