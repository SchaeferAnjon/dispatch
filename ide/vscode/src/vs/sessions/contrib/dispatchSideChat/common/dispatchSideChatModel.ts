/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the side chat's sums, worked out without the window. The side chat is a pane under the side pane's
 *  tab (direction B「Split pane」, user 2026-11-16, task-5im8n, design/side-chat-now; before it, direction A's card in
 *  the corner, task-23iin). dispatchSideChatPane.ts draws the pane, dispatchDocPassage.ts finds the passage in a
 *  document; ide/tests/side-chat-card.test.mjs tests this file. No imports: Node runs it as it is.
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

/** The pane is open, folded to its head at the side pane's bottom, or closed (the title bar's menu brings it back). */
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

export interface ISideChatBadge {
	/** After "Side chat" on the folded pane's head: `· Answering`, `· 1 new answer`, or nothing. */
	readonly text: string;
	/** A new answer came while the pane was folded: the words are 500. */
	readonly bold: boolean;
	/** The answer is still being written: the words shimmer. */
	readonly answering: boolean;
}

/** What the folded pane's head says after "Side chat" (the head says only what is new; no "from <session>"). */
export function foldedBadge(answering: boolean, unread: number): ISideChatBadge {
	if (answering) {
		return { text: '· Answering', bold: false, answering: true };
	}
	if (unread > 0) {
		return { text: unread === 1 ? '· 1 new answer' : `· ${unread} new answers`, bold: true, answering: false };
	}
	return { text: '', bold: false, answering: false };
}

/** A turn of the side chat ended: one more unread answer when nobody saw it (folded or closed), none when open. */
export function unreadAfterAnswer(mode: SideChatCardMode, unread: number): number {
	return mode === 'open' ? 0 : unread + 1;
}

/** At or below this window width the pane keeps the old card's height (58% of the room, 420 at most). */
export const SIDE_CHAT_NARROW_WINDOW = 1200;
/** The pane's head (the folded pane is this and the 1px line over it). */
export const SIDE_CHAT_HEAD = 28;
/** The pane is never shorter than this under its line: head 28, the pinned line 28, input 72, answer 72. */
export const SIDE_CHAT_MIN = 200;
/** What is over the pane (Now, a document) is never shorter than this: Now's one line. */
export const SIDE_CHAT_TOP_MIN = 32;
/** Shorter than this, Now folds into its one line. */
export const NOW_ONE_LINE_BELOW = 120;
/** The head's "· from <session>" goes when the side pane is narrower than this. */
export const SIDE_CHAT_THIN_PANE = 340;

export interface ISideChatSplit {
	/** The room left over the pane, under the tabs (Now, a document, Changes). */
	readonly top: number;
	/** The pane with its 1px line on top; 0 when closed. */
	readonly pane: number;
	/** What is over it is short: Now shows its one line. */
	readonly oneLine: boolean;
}

/** The pane's default height with its line: 55% of the room in a wide window; at most 58% and 420 in a narrow one. */
export function defaultPaneHeight(room: number, windowWidth: number): number {
	return windowWidth <= SIDE_CHAT_NARROW_WINDOW
		? Math.min(420, Math.round(room * 0.58)) + 1
		: room - Math.round(room * 0.45);
}

/**
 * How the room under the side pane's tabs is shared (direction B「Split pane」, design/side-chat-now): the tab's
 * content over the side chat's pane, a 1px line between. `share` is the part of the room the person dragged the pane
 * to (undefined: the default). Over the pane at least 32 stays, the pane at least 200 under its line; when both do not
 * fit, the 32 wins. Folded, only the head and its line are left.
 */
export function splitRoom(room: number, windowWidth: number, mode: SideChatCardMode, share?: number): ISideChatSplit {
	const h = Math.max(0, Math.round(room));
	if (mode === 'closed') {
		return { top: h, pane: 0, oneLine: false };
	}
	if (mode === 'min') {
		const pane = Math.min(h, SIDE_CHAT_HEAD + 1);
		return { top: h - pane, pane, oneLine: false };
	}
	const want = share === undefined ? defaultPaneHeight(h, windowWidth) : Math.round(h * share);
	const top = Math.max(SIDE_CHAT_TOP_MIN, Math.min(h - 1 - SIDE_CHAT_MIN, h - want));
	const pane = Math.max(0, h - top);
	return { top: h - pane, pane, oneLine: h - pane < NOW_ONE_LINE_BELOW };
}

/** Dragging the line: the pane's new share of the room for a line moved to `top` (clamped as splitRoom clamps). */
export function shareForTop(room: number, top: number): number {
	const h = Math.max(1, room);
	const t = Math.max(SIDE_CHAT_TOP_MIN, Math.min(h - 1 - SIDE_CHAT_MIN, top));
	return Math.max(0, Math.min(1, (h - t) / h));
}

export interface ISideChatBox {
	/** From the side pane's right and bottom edges, CSS px. */
	readonly right: number;
	readonly bottom: number;
	readonly width: number;
	readonly height: number;
	readonly narrow: boolean;
}

/**
 * A card in the side pane's bottom right corner (Walk me through's card, task-fktjx; the side chat's own card of
 * direction A had this box): 16 from the right and bottom, 380 wide and at most
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

/** The corner's gap from the side pane's right and bottom edges. */
export function pillOffset(windowWidth: number): number {
	return windowWidth <= SIDE_CHAT_NARROW_WINDOW ? 12 : 16;
}

/**
 * How far from the side pane's bottom the small cards of the corner start (Talk's cards, Walk me through's pill):
 * 8 over the folded pane's head, else the corner's own gap.
 */
export function cornerFloor(mode: SideChatCardMode | undefined, windowWidth: number): number {
	return mode === 'min' ? SIDE_CHAT_HEAD + 1 + 8 : windowWidth <= SIDE_CHAT_NARROW_WINDOW ? 12 : 16;
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
