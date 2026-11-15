/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE (patches/220-opencode.patch): which choices of an OpenCode question are only "let me type".
 *  No imports, so tests/opencode-questions.test.mjs runs it as it is.
 *--------------------------------------------------------------------------------------------*/

/**
 * A choice that only says "let me type": OpenCode's question tool tells the model a "Type your own answer" choice
 * comes by itself, and some models list one anyway (or "Other"). As a choice it answers with nothing typed (the
 * agent got an empty reply, task-e04j); the card's own text box is where the person types.
 */
const TYPE_YOUR_OWN = /^\s*(?:type|write|enter|give|add)\s+(?:your|my|an?)\s+(?:own\s+)?(?:answer|reply|response|value)\b|^\s*(?:other|something else|custom(?:\s+answer)?)\s*(?:[.…:(].*)?$|^\s*(?:其他|自定义|自己填|手动输入)/i;

export function isTypeYourOwnChoice(label: string): boolean {
	return TYPE_YOUR_OWN.test(label);
}
