/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: what went wrong when the first suggestions could not be read (`dispatch assistant --json`, the CLI
 *  that says them), from the error text the bridge passes on. dispatchFirstPrompts.ts says it on the card.
 *--------------------------------------------------------------------------------------------*/

export type DispatchFirstPromptsFailure = 'none' | 'old-cli' | 'busy' | 'no-cli' | 'other';

export function firstPromptsFailureKind(err: string | undefined): DispatchFirstPromptsFailure {
	const text = (err ?? '').trim();
	if (!text) {
		return 'none';
	}
	if (/invalid choice|unrecognized arguments/.test(text)) {
		return 'old-cli';
	}
	// the bridge killed the CLI at its limit: "dispatch assistant --json timed out"
	if (/timed out|timeout/i.test(text)) {
		return 'busy';
	}
	if (/ENOENT|not found|spawn/.test(text)) {
		return 'no-cli';
	}
	return 'other';
}
