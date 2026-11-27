/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a session's steps for "who wrote which line" (patches/340-attribution.patch),
 *  the plain part: what `dispatch attribution steps` answers, the words the chat row, the commit card and the
 *  All / Turn 1 / You filter say, and which reply a row goes under. No services here (tests/attribution-steps.test.mjs).
 *--------------------------------------------------------------------------------------------*/

export interface IStepFile {
	/** the file in the project */
	readonly path: string;
	readonly rel: string;
	/** a read-only copy of the version before; undefined when the file did not exist */
	readonly before?: string;
	/** the version after (a read-only copy, or the file itself while nothing came after) */
	readonly after?: string;
	readonly added?: number;
	readonly removed?: number;
	/** your lines only: "4, 6-7", how many, the first one */
	readonly lines?: string;
	readonly count?: number;
	readonly first?: number;
}

export interface IStepCommit {
	readonly hash: string;
	readonly short: string;
	readonly subject: string;
	readonly message: string;
	/** seconds */
	readonly ts: number;
	/** lines of the commit that were yours (you, or the agent then you) when the turn started */
	readonly yours: number;
	readonly agent: string;
	/**
	 * 'you': a commit you made yourself after the turn (the commit button, a terminal), not the agent's;
	 * 'turbo': a Turbo run's result brought into this branch meanwhile, made by its agent (`maker`, `engine`)
	 */
	readonly by?: 'you' | 'turbo';
	/** for a Turbo commit: the agent that made it, by name, and its engine id */
	readonly maker?: string;
	readonly engine?: string;
	/** for your own commit: the lines of it each agent wrote */
	readonly agents?: readonly { readonly agent: string; readonly lines: number }[];
	/** for your own commit made with the Commit button: the agent that wrote its message ("" when you did) */
	readonly message_by?: string;
}

export interface IStepTurn {
	readonly n: number;
	readonly agent: string;
	readonly engine: string;
	/** seconds; undefined when only the end was seen, or (end) while it runs */
	readonly start?: number;
	readonly end?: number;
	readonly text: string;
	readonly files: readonly IStepFile[];
	readonly added: number;
	readonly removed: number;
	readonly commits: readonly IStepCommit[];
	/** the commits you made yourself after this turn, before the next one started */
	readonly own_commits: readonly IStepCommit[];
}

export interface IStepYours {
	readonly after_turn: number;
	/** seconds: the end of the turn they came after (which reply the row goes under) */
	readonly anchor: number;
	/** seconds: when the session's next turn started; undefined while none has */
	readonly until?: number;
	/** seconds: your first and last saved change */
	readonly ts: number;
	readonly last: number;
	readonly count: number;
	readonly agent: string;
	/** the agent that heard about these lines when its next turn started ("" when none has yet) */
	readonly told: string;
	readonly next_turn?: number;
	readonly files: readonly IStepFile[];
}

export interface IAttributionSteps {
	readonly root: string;
	readonly turns: readonly IStepTurn[];
	readonly yours: readonly IStepYours[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | undefined => typeof v === 'number' && isFinite(v) ? v : undefined;
const str = (v: unknown): string => typeof v === 'string' ? v : '';

function parseFile(v: unknown): IStepFile | undefined {
	if (!isObj(v) || !str(v.path)) {
		return undefined;
	}
	return {
		path: str(v.path), rel: str(v.rel) || str(v.path), before: str(v.before) || undefined, after: str(v.after) || undefined,
		added: num(v.added), removed: num(v.removed), lines: str(v.lines) || undefined, count: num(v.count), first: num(v.first),
	};
}

const files = (v: unknown): IStepFile[] => Array.isArray(v) ? v.map(parseFile).filter((f): f is IStepFile => !!f) : [];

/** The CLI's answer, or undefined when it is not one. */
export function parseSteps(raw: unknown): IAttributionSteps | undefined {
	if (!isObj(raw) || raw.ok !== true || !Array.isArray(raw.turns)) {
		return undefined;
	}
	const turns: IStepTurn[] = [];
	for (const t of raw.turns) {
		if (!isObj(t) || num(t.n) === undefined) {
			continue;
		}
		const commits: IStepCommit[] = [];
		for (const c of Array.isArray(t.commits) ? t.commits : []) {
			if (isObj(c) && str(c.hash)) {
				commits.push({ hash: str(c.hash), short: str(c.short) || str(c.hash).slice(0, 7), subject: str(c.subject), message: str(c.message), ts: num(c.ts) ?? 0, yours: num(c.yours) ?? 0, agent: str(c.agent) || str(t.agent) });
			}
		}
		const own: IStepCommit[] = [];
		for (const c of Array.isArray(t.own_commits) ? t.own_commits : []) {
			if (isObj(c) && str(c.hash)) {
				const agents = (Array.isArray(c.agents) ? c.agents : []).filter(isObj).map(a => ({ agent: str(a.agent), lines: num(a.lines) ?? 0 })).filter(a => a.agent && a.lines > 0);
				own.push({ hash: str(c.hash), short: str(c.short) || str(c.hash).slice(0, 7), subject: str(c.subject), message: str(c.message), ts: num(c.ts) ?? 0, yours: num(c.yours) ?? 0, agent: str(t.agent), by: str(c.by) === 'turbo' ? 'turbo' : 'you', maker: str(c.maker), engine: str(c.engine), agents, message_by: str(c.message_by) });
			}
		}
		turns.push({ n: num(t.n)!, agent: str(t.agent) || 'The agent', engine: str(t.engine), start: num(t.start), end: num(t.end), text: str(t.text), files: files(t.files), added: num(t.added) ?? 0, removed: num(t.removed) ?? 0, commits, own_commits: own });
	}
	const yours: IStepYours[] = [];
	for (const y of Array.isArray(raw.yours) ? raw.yours : []) {
		if (!isObj(y) || num(y.anchor) === undefined) {
			continue;
		}
		const f = files(y.files);
		if (!f.length) {
			continue;
		}
		yours.push({ after_turn: num(y.after_turn) ?? 0, anchor: num(y.anchor)!, until: num(y.until), ts: num(y.ts) ?? num(y.anchor)!, last: num(y.last) ?? num(y.ts) ?? 0, count: num(y.count) ?? 0, agent: str(y.agent) || 'The agent', told: str(y.told), next_turn: num(y.next_turn), files: f });
	}
	return { root: str(raw.root), turns, yours };
}

// ---------------------------------------------------------------- words

const lines = (n: number) => n === 1 ? '1 line' : `${n} lines`;
const baseName = (p: string) => p.split('/').filter(Boolean).at(-1) ?? p;

/** "5:58 AM" */
export function clock(seconds: number | undefined): string {
	if (!seconds) {
		return '';
	}
	return new Date(seconds * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** The chat row: "You changed 2 lines in NOTES.md", or "… in 2 files". */
export function yoursLabel(y: IStepYours): string {
	const where = y.files.length === 1 ? baseName(y.files[0].rel) : `${y.files.length} files`;
	return `You changed ${lines(y.count)} in ${where}`;
}

/** The row's hover: what the agent hears about these lines. */
export function yoursTip(y: IStepYours): string {
	if (y.told) {
		return `${y.told} was told about these lines when turn ${y.next_turn ?? y.after_turn + 1} started, so it keeps them. Click to see only them.`;
	}
	if (y.until) {
		return `Turn ${y.next_turn ?? y.after_turn + 1} started without the note about these lines. Click to see only them.`;
	}
	return `${y.agent} hears about these lines when its next turn starts, so it keeps them. Click to see only them.`;
}

/** The commit card's line about your lines; "" when the commit has none of them. */
export function commitYoursLabel(n: number): string {
	return n > 0 ? `Includes ${lines(n)} you changed` : '';
}

/** Your own commit's second line: whose lines it holds ("Holds 4 lines OpenCode wrote · 2 lines you changed"). */
export function ownCommitLabel(c: IStepCommit): string {
	const parts = (c.agents ?? []).map(a => `${lines(a.lines)} ${a.agent} wrote`);
	if (c.yours > 0) {
		parts.push(`${lines(c.yours)} you changed`);
	}
	return parts.length ? `Holds ${parts.join(' · ')}` : '';
}

export function hasCoAuthor(message: string): boolean {
	return /^co-authored-by:/im.test(message);
}

// ---------------------------------------------------------------- your lines on their own in Changes

/** Your changes after a turn, shown on their own when you click their row under the reply. */
export type YoursStep = `you:${number}`;

/** The changeset id Changes shows for them (Dispatch's own, so it is told from VS Code's). */
export function changesetId(step: YoursStep): string {
	return `dispatch-attr:${step}`;
}

export function stepOfChangeset(id: string | undefined): YoursStep | undefined {
	const m = /^dispatch-attr:(you:\d+)$/.exec(id ?? '');
	return m ? m[1] as YoursStep : undefined;
}

function yoursOf(s: IAttributionSteps | undefined, step: YoursStep): IStepYours | undefined {
	const n = Number(step.slice('you:'.length));
	return s?.yours.find(y => y.after_turn === n);
}

/** The changeset's name in Changes' picker: "Your changes", then "2 lines · after turn 1 · 5:58 AM". */
export function stepNote(s: IAttributionSteps | undefined, step: YoursStep): { title: string; rest: string } | undefined {
	const y = yoursOf(s, step);
	return y ? { title: 'Your changes', rest: [lines(y.count), `after turn ${y.after_turn}`, clock(y.ts)].filter(Boolean).join(' · ') } : undefined;
}

/** The files of your changes, for Changes: before and after per file. */
export function stepFiles(s: IAttributionSteps | undefined, step: YoursStep): readonly IStepFile[] {
	return yoursOf(s, step)?.files ?? [];
}

// ---------------------------------------------------------------- which reply a row goes under

/** The reply whose request came last at or before `anchorSeconds` (requests oldest first, times in ms). */
export function replyFor(requests: readonly { id: string; ts: number }[], anchorSeconds: number, slackMs = 2000): string | undefined {
	let hit: string | undefined;
	for (const r of requests) {
		if (r.ts - slackMs <= anchorSeconds * 1000) {
			hit = r.id;
		}
	}
	return hit;
}
