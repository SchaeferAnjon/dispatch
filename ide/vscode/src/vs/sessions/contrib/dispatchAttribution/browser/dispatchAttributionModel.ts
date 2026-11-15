/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: who wrote each changed line, the agent or you (patches/340-attribution.patch).
 *
 *  The answers of `dispatch attribution show|files` (kanban app/cli/attribution.py, through
 *  dispatch-bridge's dispatch.attributionShow / dispatch.attributionFiles) and what the Changes view
 *  and the diffs draw from them. Only the lines a person touched get a mark; the agent's lines are the
 *  default and stay plain (direction B, "only what you touched").
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

/** 'other': no agent's turn was open and no Dispatch editor saw anyone type it (a tool, a script, git, another app). */
export type AttributionWho = 'ai' | 'you' | 'mix' | 'unsure' | 'other' | 'before';

/** One run of lines with the same author, 1-based and inclusive. */
export interface IAttributionRun {
	readonly from: number;
	readonly to: number;
	readonly who: AttributionWho;
	readonly ts?: number;
	readonly agent?: string;
	readonly turn?: number;
	readonly text?: string;
	readonly was?: string;
	readonly told?: string;
	readonly why?: string;
	readonly agents?: readonly string[];
}

export interface IAttributionFile {
	readonly tracked: boolean;
	readonly agents: readonly string[];
	readonly runs: readonly IAttributionRun[];
}

export interface IAttributionCounts {
	readonly tracked: boolean;
	readonly agents: readonly string[];
	readonly you: number;
	readonly mix: number;
	readonly unsure: number;
	readonly other: number;
	readonly ai: number;
}

/** What a marked line shows: a person, the agent then a person, or a dashed block (not sure, or not from an agent). */
export type AttributionMark = 'you' | 'mix' | 'unsure' | 'other';

type Row = Record<string, unknown>;
const row = (v: unknown): Row => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const str = (v: unknown) => typeof v === 'string' ? v : '';
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const count = (v: unknown) => Math.max(0, Math.floor(num(v) ?? 0));
const WHO: readonly AttributionWho[] = ['ai', 'you', 'mix', 'unsure', 'other', 'before'];
const strings = (v: unknown) => (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string');

export function parseAttributionFile(answer: unknown): IAttributionFile | undefined {
	const r = row(answer);
	if (r.ok !== true) {
		return undefined;
	}
	const runs: IAttributionRun[] = [];
	for (const v of Array.isArray(r.runs) ? r.runs : []) {
		const x = row(v);
		const from = num(x.from), to = num(x.to), who = str(x.who) as AttributionWho;
		if (from === undefined || to === undefined || to < from || !WHO.includes(who)) {
			continue;
		}
		runs.push({
			from, to, who, ts: num(x.ts), agent: str(x.agent) || undefined, turn: num(x.turn), text: str(x.text) || undefined,
			was: typeof x.was === 'string' ? x.was : undefined, told: str(x.told) || undefined, why: str(x.why) || undefined, agents: strings(x.agents),
		});
	}
	return { tracked: r.tracked === true, agents: strings(r.agents), runs };
}

export function parseAttributionFiles(answer: unknown): Map<string, IAttributionCounts> {
	const out = new Map<string, IAttributionCounts>();
	const r = row(answer);
	if (r.ok !== true) {
		return out;
	}
	for (const [path, v] of Object.entries(row(r.files))) {
		const x = row(v), c = row(x.counts);
		out.set(path, { tracked: x.tracked === true, agents: strings(x.agents), you: count(c.you), mix: count(c.mix), unsure: count(c.unsure), other: count(c.other), ai: count(c.ai) });
	}
	return out;
}

/** The mark for a changed line, undefined for the agent's own lines (no mark). A line the record
 *  started after is not sure; a line nobody Dispatch saw wrote gets no person. */
export function markOf(run: IAttributionRun | undefined): AttributionMark | undefined {
	switch (run?.who) {
		case 'you': return 'you';
		case 'mix': return 'mix';
		case 'other': return 'other';
		case 'unsure': case 'before': return 'unsure';
		default: return undefined;
	}
}

/** Changed lines (modified side, 1-based) → the mark each one gets; lines without a mark are left out. */
export function marksForLines(file: IAttributionFile, changed: readonly { readonly start: number; readonly end: number }[]): Map<number, IAttributionRun> {
	const out = new Map<number, IAttributionRun>();
	if (!file.tracked) {
		return out;
	}
	for (const { start, end } of changed) {
		for (let n = start; n <= end; n++) {
			const run = runAt(file.runs, n);
			if (markOf(run)) {
				out.set(n, run!);
			}
		}
	}
	return out;
}

export function runAt(runs: readonly IAttributionRun[], line: number): IAttributionRun | undefined {
	let lo = 0, hi = runs.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1, r = runs[mid];
		if (line < r.from) {
			hi = mid - 1;
		} else if (line > r.to) {
			lo = mid + 1;
		} else {
			return r;
		}
	}
	return undefined;
}

export function agentsLabel(agents: readonly string[]): string {
	if (agents.length <= 1) {
		return agents[0] ?? localize('dispatchAttribution.theAgent', "the agent");
	}
	return localize('dispatchAttribution.agentsOr', "{0} or {1}", agents.slice(0, -1).join(', '), agents[agents.length - 1]);
}

/** The grey line under a file's header: what a line without a mark means. */
export function hintText(file: IAttributionFile): string | undefined {
	if (!file.tracked || !file.agents.length) {
		return undefined;
	}
	return localize('dispatchAttribution.hint', "Lines without a mark were written by {0}", agentsLabel(file.agents));
}

export function clock(ts: number | undefined, now = Date.now()): string {
	if (!ts) {
		return '';
	}
	const d = new Date(ts * 1000), today = new Date(now);
	const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	if (d.toDateString() === today.toDateString()) {
		return time;
	}
	return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/** Markdown-free pieces of a marked line's hover: a bold first line, then plain lines. */
export interface IAttributionHover {
	readonly title: string;
	readonly lines: readonly string[];
	/** the agent's own text of the line before you changed it (shown as code) */
	readonly was?: string;
}

export function hoverOf(run: IAttributionRun, now = Date.now()): IAttributionHover | undefined {
	const at = clock(run.ts, now);
	const told = run.told ? localize('dispatchAttribution.told', "{0} was told to keep it when its next turn started.", run.told) : undefined;
	const turn = run.turn ? (run.text
		? localize('dispatchAttribution.turnSaid', "Turn {0}: “{1}”", run.turn, short(run.text))
		: localize('dispatchAttribution.turn', "Turn {0}", run.turn)) : undefined;
	switch (run.who) {
		case 'you':
			return { title: at ? localize('dispatchAttribution.youAt', "You changed this line · {0}", at) : localize('dispatchAttribution.you', "You changed this line"), lines: told ? [told] : [] };
		case 'mix': {
			const agent = run.agent || localize('dispatchAttribution.agent', "The agent");
			return {
				title: at ? localize('dispatchAttribution.mixAt', "{0} wrote this line, then you changed it · {1}", agent, at) : localize('dispatchAttribution.mix', "{0} wrote this line, then you changed it", agent),
				lines: [turn, told].filter((x): x is string => !!x),
				was: run.was,
			};
		}
		case 'unsure':
			return {
				title: localize('dispatchAttribution.unsure', "Not sure who wrote this line"),
				lines: [run.agents && run.agents.length > 1
					? localize('dispatchAttribution.unsureAgents', "{0} were all working here when it changed.", run.agents.join(' and '))
					: localize('dispatchAttribution.unsureOther', "It changed while Dispatch could not see who did it.")],
			};
		case 'other':
			// a tool, a script, git or another app: Dispatch cannot say who or when (a file's time says when it was
			// written, not by whom), only that no agent of its own did it (task-m6hek)
			return { title: localize('dispatchAttribution.other', "Not from an agent in Dispatch"), lines: [] };
		case 'before':
			return { title: localize('dispatchAttribution.unsure', "Not sure who wrote this line"), lines: [localize('dispatchAttribution.before', "It changed before Dispatch began keeping track of this folder.")] };
		default:
			return undefined;
	}
}

function short(text: string): string {
	const t = text.replace(/\s+/g, ' ').trim();
	return t.length > 60 ? t.slice(0, 59) + '…' : t;
}

/** The file row's mark in the Changes list: a person when you changed lines in it. */
export function rowMark(c: IAttributionCounts | undefined): { mark: AttributionMark; tip: string } | undefined {
	if (!c || !c.tracked) {
		return undefined;
	}
	const yours = c.you + c.mix;
	if (!yours) {
		return undefined;
	}
	const tip = yours === 1
		? localize('dispatchAttribution.rowOne', "You changed 1 line in this file")
		: localize('dispatchAttribution.rowMany', "You changed {0} lines in this file", yours);
	return { mark: 'you', tip: c.agents.length ? `${tip}. ${localize('dispatchAttribution.rowRest', "{0} wrote the others.", agentsLabel(c.agents))}` : tip };
}

/** The A / M / D letter of a changed file, said in words (the letter itself is hidden). */
export function changeWords(changeType: string, added: number, removed: number): string {
	const kind = changeType === 'added' ? localize('dispatchAttribution.added', "New file")
		: changeType === 'deleted' ? localize('dispatchAttribution.deleted', "Deleted")
			: localize('dispatchAttribution.modified', "Changed");
	return localize('dispatchAttribution.counts', "{0} · {1} lines added, {2} removed", kind, added, removed);
}
