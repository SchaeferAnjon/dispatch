/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: which model a session started by the harness chip runs on (250-switch-harness.patch).
 *  No imports, so tests/switch-model.test.mjs runs it in node.
 *--------------------------------------------------------------------------------------------*/

/** A switched-to session's origin: the session it continues, and the harness and model it ran on there. */
export interface ISwitchLink {
	readonly from: string;
	readonly type: string;
	readonly model?: string;
}

/**
 * The model the new session of `type` starts on (task-lj06.22): the one this conversation ran on the
 * last time it was on that harness (switching back), else the one the model chip remembers for that
 * harness, which is what the chip shows. The first turn ran on the harness's own default before.
 * `links` maps each switched-to session to its origin; `from` is the origin of the one starting now.
 */
export function dispatchSwitchModel(links: Record<string, ISwitchLink>, from: ISwitchLink | undefined, type: string, remembered: string | undefined): string | undefined {
	const seen = new Set<string>();
	for (let link = from; link && !seen.has(link.from); link = links[link.from]) {
		seen.add(link.from);
		if (harness(link.type) === harness(type) && link.model) {
			return link.model;
		}
	}
	return remembered;
}

/** One name per harness: the chip's session type (`agent-host-opencode`) and the bridge's (`opencode`) alike. */
function harness(type: string): string {
	const t = type.toLowerCase().replace(/^agent-host-/, '');
	return t === 'claude-code' ? 'claude' : t;
}

/** What a model list entry needs here: its identifier and whether its harness declares it the chat default. */
export interface ISwitchModelChoice {
	readonly identifier: string;
	readonly metadata: { readonly isDefaultForLocation?: { readonly [location: string]: boolean | undefined } };
}

/**
 * The model a switched-to session starts on when nothing above names one: the one its harness declares the
 * chat default (what a new session's chip shows), else the first. It is set before the first message: a
 * session that has run without a model of its own only shows a stand-in on its chip (GPT-5.6-Luna) while
 * the harness runs its own default (GPT-6-Astra), task-lj06.22.
 */
export function dispatchDefaultModel<T extends ISwitchModelChoice>(models: readonly T[]): T | undefined {
	return models.find(m => m.metadata.isDefaultForLocation?.['panel']) ?? models[0];
}
