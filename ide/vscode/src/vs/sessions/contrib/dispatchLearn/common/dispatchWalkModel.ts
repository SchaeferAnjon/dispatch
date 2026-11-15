/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Walk me through, the sums without the window (direction B「Talk while new」 frame 6, user 2026-11-15,
 *  task-fktjx, kanban design/learn-scene; the person: "我之前用终端时它生成的文件我从来不看，这种黑箱子让人不安心").
 *  A turn that changed files is walked stop by stop: a new file is one stop, every block of lines an edited file
 *  changed is one; at most 8 stops (the blocks of one file go together first, then "and N more in Changes"). What a
 *  stop says comes from what is already there (a new file's own first comment, the sentence the agent wrote before
 *  it changed the file); the stops left get theirs from one model call for the whole turn, else only their lines.
 *  ide/tests/learn-walk.test.mjs tests this file. No imports: Node runs it as it is.
 *--------------------------------------------------------------------------------------------*/

/** At most this many stops in a walk. */
export const MAX_WALK_STOPS = 8;

/** One block of lines a turn changed in a file (1-based, inclusive). */
export interface IWalkHunk {
	/** The lines on the file's side now; a block that only removed lines points at the line it was removed after. */
	readonly start: number;
	readonly end: number;
	readonly added: number;
	readonly removed: number;
	/** The lines it replaced on the side before (`ostart` > `oend` when it only added). */
	readonly ostart: number;
	readonly oend: number;
}

/** A block of the diff computer's (`[start, endExclusive)` on each side) as a stop's lines. */
export function hunkOf(modStart: number, modEndExclusive: number, origStart: number, origEndExclusive: number, lineCount: number): IWalkHunk {
	const added = Math.max(0, modEndExclusive - modStart);
	const removed = Math.max(0, origEndExclusive - origStart);
	if (added > 0) {
		return { start: modStart, end: modEndExclusive - 1, added, removed, ostart: origStart, oend: origEndExclusive - 1 };
	}
	// only removed: the line before the gap (the first line when the gap is at the top)
	const at = Math.max(1, Math.min(lineCount, modStart - 1 || 1));
	return { start: at, end: at, added: 0, removed, ostart: origStart, oend: origEndExclusive - 1 };
}

/** One file of the turn, as the Changes tab lists it. */
export interface IWalkFile {
	/** Its path on this Mac. */
	readonly path: string;
	/** Its path from the project's folder (what a stop shows and the model is told). */
	readonly rel: string;
	readonly isNew: boolean;
	/** Deleted in this turn: nothing to open, counted in "and N more in Changes". */
	readonly deleted?: boolean;
	/** How many lines it has now. */
	readonly lines: number;
	readonly hunks: readonly IWalkHunk[];
}

export interface IWalkStop {
	readonly path: string;
	readonly rel: string;
	readonly name: string;
	readonly isNew: boolean;
	/** The lines lit, 1-based, inclusive. */
	readonly start: number;
	readonly end: number;
	readonly added: number;
	readonly removed: number;
	/** The file's blocks this stop shows (more than one when they were put together). */
	readonly hunks: readonly IWalkHunk[];
}

export function fileName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function stopOf(f: IWalkFile, hunks: readonly IWalkHunk[]): IWalkStop {
	const base = { path: f.path, rel: f.rel, name: fileName(f.rel || f.path) };
	if (f.isNew) {
		return { ...base, isNew: true, start: 1, end: Math.max(1, f.lines), added: f.lines, removed: 0, hunks: [] };
	}
	return {
		...base, isNew: false,
		start: Math.min(...hunks.map(h => h.start)), end: Math.max(...hunks.map(h => h.end)),
		added: hunks.reduce((n, h) => n + h.added, 0), removed: hunks.reduce((n, h) => n + h.removed, 0), hunks,
	};
}

/**
 * The stops of a turn in the Changes tab's order: a new file is one, each block of an edited file one. Over `max`,
 * the file with the most stops has its blocks put together into one (again and again); still over, the first `max`
 * files are walked and the rest is `more` (deleted files are always in `more`: there is nothing to open).
 */
export function walkStops(files: readonly IWalkFile[], max = MAX_WALK_STOPS): { stops: IWalkStop[]; more: number } {
	const walked = files.filter(f => !f.deleted && (f.isNew || f.hunks.length > 0));
	let deleted = files.filter(f => f.deleted).length;
	const groups: IWalkStop[][] = walked.map(f => f.isNew ? [stopOf(f, [])] : [...f.hunks].sort((a, b) => a.start - b.start).map(h => stopOf(f, [h])));
	const count = () => groups.reduce((n, g) => n + g.length, 0);
	while (count() > max) {
		let at = -1;
		groups.forEach((g, i) => { if (g.length > 1 && (at < 0 || g.length > groups[at].length)) { at = i; } });
		if (at < 0) {
			break;
		}
		groups[at] = [stopOf(walked[at], groups[at].flatMap(s => s.hunks))];
	}
	if (groups.length > max) {
		deleted += groups.length - max;
		groups.length = max;
	}
	return { stops: groups.flat(), more: deleted };
}

/** "lines 7–18", "line 10". */
export function stopLines(s: Pick<IWalkStop, 'start' | 'end'>): string {
	return s.start === s.end ? `line ${s.start}` : `lines ${s.start}–${s.end}`;
}

function n(count: number, one: string, many: string): string {
	return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/** What kind of stop it is, before its lines: New file, 3 lines added, 2 lines changed, 1 line removed, 3 changes. */
export function stopTag(s: Pick<IWalkStop, 'isNew' | 'added' | 'removed' | 'hunks'>): string {
	if (s.isNew) {
		return 'New file';
	}
	if (s.hunks.length > 1) {
		return `${s.hunks.length} changes`;
	}
	if (s.removed === 0) {
		return n(s.added, 'line added', 'lines added');
	}
	if (s.added === 0) {
		return n(s.removed, 'line removed', 'lines removed');
	}
	return n(s.added, 'line changed', 'lines changed');
}

/** What a stop says when nothing else could be found: only its lines. */
export function linesSentence(s: Pick<IWalkStop, 'start' | 'end'>): string {
	return s.start === s.end ? `Changed line ${s.start}.` : `Changed lines ${s.start}–${s.end}.`;
}

/**
 * The agent's own sentences about a file (in the order it wrote them) given to its stops: one each when there are as
 * many as stops, the first to a file of one stop; otherwise none (one sentence cannot say which block it was about).
 */
export function assignSaid(stops: number, said: readonly string[]): (string | undefined)[] {
	const unique = [...new Set(said.map(s => s.trim()).filter(Boolean))];
	if (!unique.length) {
		return new Array(stops).fill(undefined);
	}
	if (unique.length === stops) {
		return unique;
	}
	return stops === 1 ? [unique[0]] : new Array(stops).fill(undefined);
}

/** Where a stop's sentence came from: the file's first comment, the agent's own sentence, the model, its lines. */
export type WalkSource = 'comment' | 'agent' | 'model' | 'lines';

/** A sentence as the card shows it: one line of words, ending in a full stop. */
export function asSentence(s: string): string {
	const t = s.replace(/\s+/g, ' ').trim();
	return !t ? t : /[.!?。！？…]$/.test(t) ? t : `${t}.`;
}

/** The code a stop shows the model: a new file's first lines, else each block's lines before (-) and now (+). */
export function stopCode(s: IWalkStop, now: readonly string[], before: readonly string[], maxLines = 60): string {
	const out: string[] = [];
	if (s.isNew) {
		out.push(...now.slice(0, maxLines));
	} else {
		for (const h of s.hunks) {
			for (let i = h.ostart; i <= h.oend && out.length < maxLines; i++) {
				out.push(`-${before[i - 1] ?? ''}`);
			}
			for (let i = h.added ? h.start : h.end + 1; i <= h.end && out.length < maxLines; i++) {
				out.push(`+${now[i - 1] ?? ''}`);
			}
			if (out.length >= maxLines) {
				break;
			}
		}
	}
	return out.join('\n');
}

/** The pill's count: "1 stop", "4 stops". */
export function stopsLabel(count: number): string {
	return n(count, 'stop', 'stops');
}

/** What a key does on the walk's card: → next, ← back, Esc ends. */
export function walkKey(key: string): 'next' | 'back' | 'end' | undefined {
	return key === 'ArrowRight' ? 'next' : key === 'ArrowLeft' ? 'back' : key === 'Escape' ? 'end' : undefined;
}
