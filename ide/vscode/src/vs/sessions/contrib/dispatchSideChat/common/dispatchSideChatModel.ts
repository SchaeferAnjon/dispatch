/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the side chat card's sums, worked out without the window (direction A「Bottom-right card」, user
 *  2026-11-15, task-23iin, kanban design/side-chat). dispatchSideChatCard.ts draws the card, dispatchDocPassage.ts
 *  finds the passage in a document; ide/tests/side-chat-card.test.mjs tests this file. No imports: Node runs it as
 *  it is.
 *--------------------------------------------------------------------------------------------*/

/** The passage a side chat was asked about, in a document of the Docs tab or a file (1-based lines). */
export interface ISideChatPassage {
	/** The file's path on this Mac. */
	readonly path: string;
	readonly start: number;
	readonly end: number;
	/** The words that were selected. */
	readonly text: string;
	/** Asked in the Docs tab's reader (a click scrolls the reader back); else a file in an editor. */
	readonly inDocs: boolean;
	/** Where it was asked when that is not a document or a file in an editor: a diff in Changes, the terminal's
	 *  output, a small card about what the agent did (dispatchLearn, task-q9x2r). A terminal's and a command's passage
	 *  has no file (`path` is ''). */
	readonly from?: SideChatPassageFrom;
	/** The quote's second line when the place is not a file's lines (`reminder.ts · New file`). */
	readonly where?: string;
}

export type SideChatPassageFrom = 'file' | 'diff' | 'terminal' | 'learn';

/** The card is open, folded into the pill at the bottom right, or closed (the title bar's menu brings it back). */
export type SideChatCardMode = 'open' | 'min' | 'closed';

/** The file name of a path. */
export function fileName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** The quoted passage's second line: `HANDOFF.md · line 3`, `HANDOFF.md · lines 3-5`. */
export function passageWhere(p: Pick<ISideChatPassage, 'path' | 'start' | 'end'>): string {
	const name = fileName(p.path);
	return p.end > p.start ? `${name} · lines ${p.start}-${p.end}` : `${name} · line ${p.start}`;
}

/** The quote's second line: a file's lines, then `· Changes` for a diff; `Terminal` for the terminal's output; or
 *  the place the asker named (task-q9x2r: 引用卡写清来源). */
export function passageSource(p: Pick<ISideChatPassage, 'path' | 'start' | 'end' | 'from' | 'where'>): string {
	if (p.where) {
		return p.where;
	}
	if (p.from === 'terminal') {
		return 'Terminal';
	}
	return p.from === 'diff' ? `${passageWhere(p)} · Changes` : passageWhere(p);
}

/** The words of a passage on one line: whitespace folded, cut with … after `max` characters. */
export function passageLine(text: string, max = 120): string {
	const one = text.replace(/\s+/g, ' ').trim();
	return one.length > max ? one.slice(0, max - 1).trimEnd() + '…' : one;
}

/**
 * The selection a side chat carries for the agent is `<where>\n<words>` (dispatchQuote.contribution.ts) or just the
 * words (a reply's Ask Question): what the card shows when it knows nothing else about the passage.
 */
export function splitSelection(selection: string | undefined): { where: string; text: string } {
	if (!selection) {
		return { where: '', text: '' };
	}
	const nl = selection.indexOf('\n');
	const first = nl < 0 ? selection : selection.slice(0, nl);
	// `docs/HANDOFF.md:3` or `docs/HANDOFF.md:3-5`: a place, not words
	if (nl > 0 && /^[^\s].*:\d+(?:-\d+)?$/.test(first.trim())) {
		const m = /^(.*):(\d+)(?:-(\d+))?$/.exec(first.trim())!;
		const start = Number(m[2]), end = Number(m[3] ?? m[2]);
		return { where: passageWhere({ path: m[1], start, end }), text: selection.slice(nl + 1) };
	}
	return { where: '', text: selection };
}

export interface ISideChatPill {
	readonly text: string;
	/** A new answer came while the card was folded: the pill's words are 500. */
	readonly bold: boolean;
	/** The answer is still being written: the words shimmer. */
	readonly answering: boolean;
}

/** What the folded card's pill says. */
export function pillLabel(answering: boolean, unread: number): ISideChatPill {
	if (answering) {
		return { text: 'Side chat · Answering', bold: false, answering: true };
	}
	if (unread > 0) {
		return { text: unread === 1 ? 'Side chat · 1 new answer' : `Side chat · ${unread} new answers`, bold: true, answering: false };
	}
	return { text: 'Side chat', bold: false, answering: false };
}

/** A turn of the side chat ended: one more unread answer when nobody saw it (folded or closed), none when open. */
export function unreadAfterAnswer(mode: SideChatCardMode, unread: number): number {
	return mode === 'open' ? 0 : unread + 1;
}

/** Below this window width the card fills the side pane's width (the prototype's narrow window, 1100 wide). */
export const SIDE_CHAT_NARROW_WINDOW = 1200;

export interface ISideChatBox {
	/** From the side pane's right and bottom edges, CSS px. */
	readonly right: number;
	readonly bottom: number;
	readonly width: number;
	readonly height: number;
	readonly narrow: boolean;
}

/**
 * Where the card sits in the side pane (the prototype's `.card`): 16 from the right and bottom, 380 wide and at most
 * 470 high, leaving the pane's top 96 (its tabs and the document's head) free. In a window narrower than 1200 the card
 * fills the pane's width with 12 on each side and takes at most 58% of its height (420 at most).
 */
export function cardBox(paneWidth: number, paneHeight: number, windowWidth: number): ISideChatBox {
	const narrow = windowWidth <= SIDE_CHAT_NARROW_WINDOW;
	const gap = narrow ? 12 : 16;
	const width = Math.max(0, narrow ? paneWidth - 2 * gap : Math.min(380, paneWidth - 2 * gap));
	// the pane's top 96 stays free above the card, which sits `gap` off the bottom (task-q9x2r designer review: a short
	// pane under the terminal had the card over the Changes tab's first row)
	const want = narrow ? Math.min(420, Math.round(paneHeight * 0.58)) : Math.min(470, paneHeight - 96 - gap);
	const height = Math.max(0, Math.min(paneHeight - 2 * gap, Math.max(240, want)));
	return { right: gap, bottom: gap, width, height, narrow };
}

/** The pill sits where the card's bottom right corner was. */
export function pillOffset(windowWidth: number): number {
	return windowWidth <= SIDE_CHAT_NARROW_WINDOW ? 12 : 16;
}

/**
 * Where `needle` is in `hay` when runs of whitespace count as one space (a selection's text keeps the line breaks
 * the page has; the page's text nodes keep the source's): the start and end offsets in `hay`, or undefined.
 */
export function findPassage(hay: string, needle: string): { start: number; end: number } | undefined {
	const want = needle.replace(/\s+/g, ' ').trim();
	if (!want) {
		return undefined;
	}
	// the hay with whitespace folded, and where each folded character came from
	let folded = '';
	const from: number[] = [];
	let space = false;
	for (let i = 0; i < hay.length; i++) {
		if (/\s/.test(hay[i])) {
			if (!space && folded.length) {
				folded += ' ';
				from.push(i);
			}
			space = true;
			continue;
		}
		space = false;
		folded += hay[i];
		from.push(i);
	}
	const at = folded.indexOf(want);
	if (at < 0) {
		return undefined;
	}
	return { start: from[at], end: from[at + want.length - 1] + 1 };
}

/** An answer kept on the passage it was asked about (Keep as comment). */
export interface IDocComment {
	readonly id: string;
	readonly path: string;
	readonly start: number;
	readonly end: number;
	/** The passage's words. */
	readonly text: string;
	/** The answer, as the agent wrote it (Markdown). */
	readonly body: string;
	/** The side chat it came from. */
	readonly chat?: string;
	readonly at: number;
}

/** The comments kept, with this one added; the same answer kept twice on the same passage stays one. */
export function withComment(all: readonly IDocComment[], c: IDocComment): IDocComment[] {
	const same = (x: IDocComment) => x.path === c.path && x.start === c.start && x.end === c.end && x.body === c.body;
	return all.some(same) ? [...all] : [...all, c];
}

/** The comments of one document, top to bottom. */
export function commentsOf(all: readonly IDocComment[], path: string): IDocComment[] {
	return all.filter(c => c.path === path).sort((a, b) => a.start - b.start || a.at - b.at);
}

/** Reads the stored comments, dropping anything that is not one. */
export function parseComments(raw: string | undefined): IDocComment[] {
	if (!raw) {
		return [];
	}
	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(v)) {
		return [];
	}
	return v.filter((c): c is IDocComment => !!c && typeof c === 'object'
		&& typeof c.id === 'string' && typeof c.path === 'string' && typeof c.body === 'string' && typeof c.text === 'string'
		&& Number.isFinite(c.start) && Number.isFinite(c.end) && Number.isFinite(c.at));
}
