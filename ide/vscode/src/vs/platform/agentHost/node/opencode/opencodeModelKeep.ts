/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE (opencode-models-retry): a listing of `opencode models` that lost a provider.
 *  Under load, or while OpenCode rewrites its models cache, one listing can miss a provider whose
 *  key is there (seen: 4 providers of 5, Zhipu's coding plan gone right after a session started).
 *  The model menu then lost every model of it, and a chat on one of them showed OpenCode's default
 *  model on its chip (seen twice in a row, five minutes apart, until a new process listed it again).
 *  So a provider whose key OpenCode keeps (auth.json, or a provider in its config) stays in the menu
 *  whatever one listing says; any other provider leaves once two listings in a row miss it.
 *--------------------------------------------------------------------------------------------*/

export interface IKeptModels<T> {
	/** The models to show: this listing's, and the earlier models of providers it missed for the first time. */
	readonly models: readonly T[];
	/** Providers this listing missed and that stay (their key is kept, or it is the first miss). */
	readonly kept: readonly string[];
	/** Providers missed twice in a row with no key kept for them: gone. */
	readonly dropped: readonly string[];
}

export function keepMissingProviders<T extends { readonly providerId: string }>(previous: readonly T[], next: readonly T[], missedBefore: ReadonlySet<string>, configured: ReadonlySet<string> = new Set()): IKeptModels<T> {
	const now = new Set(next.map(m => m.providerId));
	const missing = [...new Set(previous.map(m => m.providerId))].filter(p => !now.has(p));
	const kept = missing.filter(p => configured.has(p) || !missedBefore.has(p));
	const dropped = missing.filter(p => !configured.has(p) && missedBefore.has(p));
	const keep = new Set(kept);
	return { models: [...next, ...previous.filter(m => keep.has(m.providerId))], kept, dropped };
}

/** The providers OpenCode keeps a key or a definition for: auth.json's entries and each config's `provider`. */
export function configuredProviders(auth: unknown, configs: readonly unknown[]): Set<string> {
	const out = new Set<string>();
	if (auth && typeof auth === 'object') {
		for (const id of Object.keys(auth)) {
			out.add(id);
		}
	}
	for (const c of configs) {
		const provider = c && typeof c === 'object' ? (c as { provider?: unknown }).provider : undefined;
		if (provider && typeof provider === 'object') {
			for (const id of Object.keys(provider)) {
				out.add(id);
			}
		}
	}
	return out;
}
