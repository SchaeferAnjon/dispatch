/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: what the slash menu of the Agents window shows (dispatchSlashMenu.ts draws it).
 *  One menu, grouped: Commands, Skills, MCP, Plugins, Agents, Model. Typing `/` shows every group with
 *  its first four entries; typing more filters across groups; typing a whole group name (`/skills`)
 *  shows only that group. A command this engine does not have here but another engine or the engine's
 *  own terminal does gets a grey row saying why and where (`dispatch slash`). Pure logic, no DOM.
 *--------------------------------------------------------------------------------------------*/

import { fuzzyScore, FuzzyScoreOptions } from '../../../../base/common/filters.js';

export const enum SlashGroupId {
	Commands = 'commands',
	Skills = 'skills',
	Mcp = 'mcp',
	Plugins = 'plugins',
	Agents = 'agents',
	Model = 'model',
}

export const SLASH_GROUP_ORDER: readonly SlashGroupId[] = [SlashGroupId.Commands, SlashGroupId.Skills, SlashGroupId.Mcp, SlashGroupId.Plugins, SlashGroupId.Agents, SlashGroupId.Model];

/** The names that show one group on their own. */
const GROUP_ALIASES: ReadonlyMap<string, SlashGroupId> = new Map([
	['commands', SlashGroupId.Commands], ['command', SlashGroupId.Commands],
	['skills', SlashGroupId.Skills], ['skill', SlashGroupId.Skills],
	['mcp', SlashGroupId.Mcp],
	['plugins', SlashGroupId.Plugins], ['plugin', SlashGroupId.Plugins],
	['agents', SlashGroupId.Agents], ['agent', SlashGroupId.Agents],
	['model', SlashGroupId.Model], ['models', SlashGroupId.Model],
]);

/** What choosing an entry does: the only four outcomes. */
export const enum SlashAction {
	/** send it now */
	Run = 'run',
	/** put it in the input, the person writes the rest */
	Insert = 'insert',
	/** open its page (Customizations, the model picker) */
	Open = 'open',
	/** change the session's model or agent */
	Switch = 'switch',
}

export interface ISlashEntry {
	/** unique in the menu */
	readonly id: string;
	readonly group: SlashGroupId;
	/** what is typed and matched, without a slash: `compact`, `figma:figma-use`, `codex_apps`, `Opus 5.5` */
	readonly name: string;
	/** shown with a leading slash (commands and skills) */
	readonly slash: boolean;
	readonly description: string;
	readonly action: SlashAction;
	/** other names that find it (`cost` finds `usage`) */
	readonly aliases?: readonly string[];
	/** the session's current model or agent */
	readonly current?: boolean;
	/** kept at the end of its group whatever is typed (All models and effort) */
	readonly trailing?: boolean;
}

/** A command this session cannot run here: why, where, and what Enter does (`dispatch slash`). */
export interface ISlashGrayEntry {
	readonly name: string;
	readonly why: string;
	readonly where: string;
	readonly go: string;
}

export type SlashRow =
	| { readonly kind: 'header'; readonly group: SlashGroupId; readonly count: number }
	| { readonly kind: 'grayHeader' }
	| { readonly kind: 'item'; readonly entry: ISlashEntry }
	| { readonly kind: 'more'; readonly group: SlashGroupId; readonly total: number; readonly matches: boolean }
	| { readonly kind: 'gray'; readonly entry: ISlashGrayEntry }
	| { readonly kind: 'empty'; readonly query: string };

/** How many entries a group shows before its Show all row: 4 when browsing, 6 when filtering. */
export const BROWSE_CAP = 4;
export const FILTER_CAP = 6;
/** Grey rows only once this many characters are typed, so `/c` does not list half the other engines. */
export const GRAY_MIN_QUERY = 3;

/**
 * The query when the input is a slash command being typed: the whole input is one `/token` (the
 * menu closes at the first space, what follows is the argument). Lower-cased, without the slash.
 */
export function parseSlashQuery(text: string): string | undefined {
	return /^\/[^\s]*$/.test(text) ? text.slice(1).toLowerCase() : undefined;
}

export function groupOfAlias(query: string): SlashGroupId | undefined {
	return GROUP_ALIASES.get(query);
}

export function isGroupAlias(name: string): boolean {
	return GROUP_ALIASES.has(name.toLowerCase());
}

/** How well `entry` matches `query`: 0 is no match; a name that starts with it first, fuzzy last. */
export function scoreEntry(entry: Pick<ISlashEntry, 'name' | 'description' | 'aliases'>, query: string): number {
	if (!query) {
		return 1;
	}
	const name = entry.name.toLowerCase();
	if (name === query) {
		return 6;
	}
	if (name.startsWith(query)) {
		return 5;
	}
	if (entry.aliases?.some(a => a.toLowerCase().startsWith(query))) {
		return 4.5;
	}
	// `figma:figma-use`, `anthropic-skills:pdf`: the part after the plugin's name counts as a start too
	const tail = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : '';
	if (tail && tail.startsWith(query)) {
		return 4;
	}
	if (name.split(/[-_\s.]/).some(word => word.startsWith(query))) {
		return 3.5;
	}
	if (name.includes(query)) {
		return 3;
	}
	// letters in order, the first one at the start of a word (`secrev` finds security-review)
	if (query.length > 1 && fuzzyScore(query, query, 0, entry.name, name, 0, FuzzyScoreOptions.default)) {
		return 2;
	}
	if (query.length >= GRAY_MIN_QUERY && entry.description.toLowerCase().includes(query)) {
		return 1;
	}
	return 0;
}

/**
 * The rows for `query` (undefined: the menu is closed). `expanded` are the groups whose Show all was
 * chosen. Entries come in the order they should appear inside their group.
 */
export function buildSlashRows(entries: readonly ISlashEntry[], gray: readonly ISlashGrayEntry[], query: string, expanded: ReadonlySet<SlashGroupId>): SlashRow[] {
	const rows: SlashRow[] = [];
	const byGroup = new Map<SlashGroupId, ISlashEntry[]>();
	for (const entry of entries) {
		let list = byGroup.get(entry.group);
		if (!list) {
			list = [];
			byGroup.set(entry.group, list);
		}
		list.push(entry);
	}
	const countOf = (list: readonly ISlashEntry[]) => list.filter(e => !e.trailing).length;

	// `/` alone: every group, its first entries
	if (!query) {
		for (const group of SLASH_GROUP_ORDER) {
			const list = byGroup.get(group);
			if (!list?.length) {
				continue;
			}
			pushGroup(rows, group, list, countOf(list), expanded.has(group) ? Infinity : BROWSE_CAP, false);
		}
		return rows;
	}

	// a whole group name: that group only, all of it
	const aliasGroup = groupOfAlias(query);
	if (aliasGroup) {
		const list = byGroup.get(aliasGroup) ?? [];
		rows.push({ kind: 'header', group: aliasGroup, count: countOf(list) });
		for (const entry of list) {
			rows.push({ kind: 'item', entry });
		}
		if (!list.length) {
			rows.push({ kind: 'empty', query });
		}
		return rows;
	}

	// filter across groups; a command this session cannot run gets its grey row
	const known = new Set(entries.filter(e => e.slash).map(e => e.name.toLowerCase()));
	const grayHits = query.length >= GRAY_MIN_QUERY ? gray.filter(g => g.name.toLowerCase().startsWith(query) && !known.has(g.name.toLowerCase())) : [];
	const exactGray = grayHits.some(g => g.name.toLowerCase() === query);
	const pushGray = () => {
		if (grayHits.length) {
			rows.push({ kind: 'grayHeader' });
			for (const entry of grayHits) {
				rows.push({ kind: 'gray', entry });
			}
		}
	};
	if (exactGray) {
		pushGray();
	}
	for (const group of SLASH_GROUP_ORDER) {
		const list = byGroup.get(group);
		if (!list?.length) {
			continue;
		}
		const hits = list
			.map((entry, index) => ({ entry, index, score: entry.trailing ? 0 : scoreEntry(entry, query) }))
			.filter(h => h.score > 0)
			.sort((a, b) => b.score - a.score || a.index - b.index)
			.map(h => h.entry);
		if (!hits.length) {
			continue;
		}
		pushGroup(rows, group, hits, hits.length, expanded.has(group) ? Infinity : FILTER_CAP, true);
	}
	if (!exactGray) {
		pushGray();
	}
	if (!rows.length) {
		rows.push({ kind: 'empty', query });
	}
	return rows;
}

function pushGroup(rows: SlashRow[], group: SlashGroupId, list: readonly ISlashEntry[], count: number, cap: number, matches: boolean): void {
	rows.push({ kind: 'header', group, count });
	const regular = list.filter(e => !e.trailing);
	for (const entry of regular.slice(0, cap)) {
		rows.push({ kind: 'item', entry });
	}
	if (regular.length > cap) {
		rows.push({ kind: 'more', group, total: regular.length, matches });
		return;
	}
	// the group's own way further (All models and effort) once the whole group is in view
	if (!matches) {
		for (const entry of list.filter(e => e.trailing)) {
			rows.push({ kind: 'item', entry });
		}
	}
}

/** Rows the keyboard stops on. */
export function isSelectableRow(row: SlashRow): row is Extract<SlashRow, { readonly kind: 'item' | 'more' | 'gray' }> {
	return row.kind === 'item' || row.kind === 'more' || row.kind === 'gray';
}

/** The next selectable row from `from` in direction `delta` (1 or -1), wrapping round; -1 when none. */
export function nextSelectable(rows: readonly SlashRow[], from: number, delta: 1 | -1): number {
	const n = rows.length;
	if (!n) {
		return -1;
	}
	for (let step = 1; step <= n; step++) {
		const i = ((from + delta * step) % n + n) % n;
		if (isSelectableRow(rows[i])) {
			return i;
		}
	}
	return -1;
}

/** The first selectable row, or -1. */
export function firstSelectable(rows: readonly SlashRow[]): number {
	return rows.findIndex(isSelectableRow);
}
