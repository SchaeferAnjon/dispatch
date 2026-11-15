/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: where Turbo hooks into pages that are not its own (patches/420-turbo.patch).
 *  Nothing is imported here, so the new-session input, the sessions list, the bottom bar and the account menu
 *  can call in without loading Turbo; dispatchTurbo.contribution.ts fills the hooks when it loads.
 *
 *    send   the new-session input asks it first: while the Turbo switch is on (a new chat's page only),
 *           the message becomes a Turbo plan instead of a session, split and run by the agent and model picked
 *           in the input box; it answers undefined when it does not take it
 *    open   the Timeline page; with a part, that part's lane lights up and opens
 *    live   the run that goes now (or ended within the hour), as `dispatch turbo list` says it: the sessions
 *           list draws its row under the project's folder, the bottom bar and the account menu its bolt and
 *           the stripes of the allowance it still plans to use
 *    hover  the part the pointer is on, in the Timeline or in the sessions list: the other one lights it too
 *--------------------------------------------------------------------------------------------*/

/** The Timeline page's custom view and the command that opens it (the side bar's Timeline entry, Show Timeline). */
export const DISPATCH_TIMELINE_VIEW_ID = 'dispatch.turbo.timeline';
export const DISPATCH_TIMELINE_OPEN = 'dispatch.turbo.timeline.open';

/** A run in short (kanban app/cli/turbo.py, live_row()). */
export interface ITurboLive {
	readonly id: string;
	readonly title: string;
	readonly state: string;
	readonly project: string;
	readonly repo: string;
	readonly engine: string;
	readonly engine_name?: string;
	readonly combined: number;
	readonly total: number;
	readonly needs?: number;
	readonly parts?: readonly { readonly n: number; readonly name: string; readonly status: string }[];
	readonly paused?: boolean;
	readonly slowed?: boolean;
	readonly resume_at?: number | null;
	/** % of the allowance in use, when it is readable. */
	readonly used?: number | null;
	/** % more the run plans to use before it is done (the stripes). */
	readonly plans_more?: number | null;
}

/** What is picked in the input box when the message is sent: the agent's session type and the model's id. */
export interface ITurboPick {
	readonly sessionType?: string;
	readonly model?: string;
}

/** The agent Turbo runs on for a picked session type ("agent-host-opencode" → opencode); undefined for another. */
export function turboEngineOf(sessionType: string | undefined): 'claude' | 'codex' | 'opencode' | undefined {
	const m = /(?:^|[-:])(claude|codex|opencode)$/.exec(sessionType ?? '');
	return m ? m[1] as 'claude' | 'codex' | 'opencode' : undefined;
}

/**
 * The model's name as the engine's own command line takes it. The window's picker hands out its own ids
 * ("@provider=anthropic:sonnet"): Claude Code and Codex take the bare name ("sonnet"), OpenCode "provider/model".
 * Passed on as it was, every Turbo plan from the new-session page failed with "unrecognized_model".
 */
export function turboModelOf(engine: 'claude' | 'codex' | 'opencode', model: string | undefined): string | undefined {
	if (!model || model === 'auto') {
		return undefined;
	}
	const m = /^@provider=([^:]+):(.+)$/.exec(model);
	if (!m) {
		return model;
	}
	return engine === 'opencode' ? `${m[1]}/${m[2]}` : m[2];
}

export const dispatchTurboHooks: {
	send?: (query: string, pick?: ITurboPick) => Promise<boolean> | undefined;
	live?: ITurboLive;
	hover?: { readonly run: string; readonly n: number };
	/** Open the Timeline page; with a part, that part's lane lights up and opens. */
	open?: (part?: number) => void;
} = {};

const listeners = new Set<(what: 'live' | 'hover') => void>();

/** Called when `live` or `hover` changed. */
export function onDispatchTurboChange(listener: (what: 'live' | 'hover') => void): { dispose(): void } {
	listeners.add(listener);
	return { dispose: () => listeners.delete(listener) };
}

export function setDispatchTurboLive(live: ITurboLive | undefined): void {
	if (JSON.stringify(live) === JSON.stringify(dispatchTurboHooks.live)) {
		return;
	}
	dispatchTurboHooks.live = live;
	for (const l of [...listeners]) {
		l('live');
	}
}

export function setDispatchTurboHover(hover: { run: string; n: number } | undefined): void {
	const was = dispatchTurboHooks.hover;
	if (was?.run === hover?.run && was?.n === hover?.n) {
		return;
	}
	dispatchTurboHooks.hover = hover;
	for (const l of [...listeners]) {
		l('hover');
	}
}

/** A run that goes now: the bolt shows, the stripes are what it still plans to use. */
export function turboGoing(live: ITurboLive | undefined): live is ITurboLive {
	return !!live && ['running', 'paused', 'combining'].includes(live.state);
}
