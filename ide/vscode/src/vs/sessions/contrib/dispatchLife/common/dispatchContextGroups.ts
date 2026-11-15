/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Context card's chart (user 2026-10-20: "how much do skills, the conversation, MCP and the system
 *  take"). Claude Code's own /context rows (dispatchContextUsage.ts in the agent host) grouped into the four the person
 *  asked about, plus what is free and what Claude Code keeps back for compacting; and a 10 × 10 grid, one square for
 *  each percent of the window, the way /context draws it.
 *--------------------------------------------------------------------------------------------*/

export type ContextGroupKey = 'system' | 'mcp' | 'skills' | 'conversation' | 'free' | 'reserved';

export interface IContextBreakdown {
	readonly total?: number;
	readonly max?: number;
	readonly categories?: readonly { readonly name: string; readonly tokens: number; readonly deferred?: boolean }[];
}

export interface IContextGroup {
	readonly key: ContextGroupKey;
	readonly label: string;
	readonly tokens: number;
	/** Of the whole window, one decimal. */
	readonly percent: number;
	/** What went into it, as Claude Code names the rows ("System prompt", "System tools", "Memory files" …). */
	readonly parts: readonly { readonly name: string; readonly tokens: number }[];
}

const ORDER: readonly ContextGroupKey[] = ['system', 'mcp', 'skills', 'conversation', 'free', 'reserved'];
const LABEL: Record<ContextGroupKey, string> = {
	system: 'System and tools', mcp: 'MCP tools', skills: 'Skills', conversation: 'Conversation',
	free: 'Free', reserved: 'Kept for compacting',
};

function groupOf(name: string): ContextGroupKey {
	if (/^messages/i.test(name)) { return 'conversation'; }
	if (/^skills?\b/i.test(name)) { return 'skills'; }
	if (/^mcp/i.test(name)) { return 'mcp'; }
	if (/^free/i.test(name)) { return 'free'; }
	if (/buffer|compact/i.test(name)) { return 'reserved'; }
	return 'system';
}

/** The groups in drawing order, empty ones left out; undefined without a window to measure against. */
export function contextGroups(b: IContextBreakdown | undefined): IContextGroup[] | undefined {
	const max = b?.max ?? 0;
	if (!b?.categories?.length || max <= 0) {
		return undefined;
	}
	const parts = new Map<ContextGroupKey, { name: string; tokens: number }[]>();
	for (const c of b.categories) {
		if (c.deferred || !(c.tokens > 0)) {
			continue;
		}
		const key = groupOf(c.name);
		parts.set(key, [...(parts.get(key) ?? []), { name: c.name, tokens: c.tokens }]);
	}
	return ORDER.filter(k => parts.has(k)).map(key => {
		const tokens = parts.get(key)!.reduce((n, p) => n + p.tokens, 0);
		return { key, label: LABEL[key], tokens, percent: Math.round(tokens / max * 1000) / 10, parts: parts.get(key)! };
	});
}

/** 100 squares, one per percent of the window, each the group it belongs to (largest remainders, so they add up). */
export function contextGrid(groups: readonly IContextGroup[], cells = 100): ContextGroupKey[] {
	const total = groups.reduce((n, g) => n + g.tokens, 0);
	if (total <= 0) {
		return [];
	}
	const exact = groups.map(g => g.tokens / total * cells);
	const counts = exact.map(Math.floor);
	let left = cells - counts.reduce((n, c) => n + c, 0);
	const byRemainder = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r);
	for (const { i } of byRemainder) {
		if (left-- <= 0) { break; }
		counts[i]++;
	}
	// a group that has tokens shows at least one square, taken from the largest
	for (let i = 0; i < groups.length; i++) {
		if (counts[i] === 0 && groups[i].tokens > 0) {
			const big = counts.indexOf(Math.max(...counts));
			counts[big]--;
			counts[i]++;
		}
	}
	return groups.flatMap((g, i) => Array<ContextGroupKey>(counts[i]).fill(g.key));
}
