/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: learning while the agent works, the third part: "see it" and "ask it" (user 2026-11-15, task-39x97,
 *  kanban design/learn-scene frames 1, 4 and 5; the person: "终端生成的文件我从来不看，黑箱子让人不安心"). The sums
 *  without the window:
 *
 *  - Now's why line: one plain sentence under the agent's line, what this turn does and why. Its words come from the
 *    agent only: the line it wrote itself with `dispatch now` (when the head shows something else there), else what
 *    it wrote at the start of the turn before it did anything (its plan); no model is asked for it.
 *
 *  ide/tests/learn-explain.test.mjs tests this file. No imports: Node runs it as it is.
 *--------------------------------------------------------------------------------------------*/

// ---- Now: one sentence of why ---------------------------------------------------------------------------------

/** A piece of the turn's reply, as far as the why line cares: words the agent wrote, or something it did. */
export interface ITurnPiece {
	readonly kind: 'text' | 'call' | 'other';
	readonly text?: string;
}

/** At most this many characters in the why line (three lines in a narrow side pane). */
export const WHY_MAX = 220;

/** Sentences that say nothing about the turn: an acknowledgement, a greeting. */
const FILLER = /^(sure|ok(ay)?|alright|all right|got it|great|of course|certainly|absolutely|understood|will do|yes|no problem|好的|好|明白|收到|没问题)[\s,.!。！]*$/i;

/** Markdown as words: no code, no link targets, no list marks, one line. */
export function plainWords(md: string): string {
	return md
		.replace(/```[\s\S]*?(```|$)/g, ' ')
		.replace(/`([^`\n]*)`/g, '$1')
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
		.replace(/[*_~]{1,3}([^*_~\n]+)[*_~]{1,3}/g, '$1')
		.replace(/\s+/g, ' ')
		.trim();
}

/** The sentences of a line of words, each with its end mark. */
export function sentencesOf(text: string): string[] {
	// an end mark with a space after it, or a Chinese one: a full stop inside a word (v1.2, app.ts) is not an end
	return text.split(/(?<=[.!?:：])\s+|(?<=[。！？])/).map(s => s.trim()).filter(Boolean);
}

/** At most `max` characters, cut at a word with "…". */
export function clip(text: string, max = WHY_MAX): string {
	if (text.length <= max) {
		return text;
	}
	const cut = text.slice(0, max - 1);
	const space = cut.lastIndexOf(' ');
	return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:，；：]+$/, '')}…`;
}

/**
 * What the agent wrote at the start of the turn before its first call: its plan, or what it is about to do. Only when
 * a call follows (a turn that only answered has no plan; words still being written may stop mid-sentence, so only
 * finished sentences count). Acknowledgements are passed over; a sentence that only leads into a list ("Here's the
 * plan:") gives way to the next one; at most two sentences.
 */
export function openingWords(pieces: readonly ITurnPiece[]): string {
	const firstCall = pieces.findIndex(p => p.kind === 'call');
	if (firstCall < 0) {
		return '';
	}
	const words = plainWords(pieces.slice(0, firstCall).filter(p => p.kind === 'text').map(p => p.text ?? '').join('\n\n'));
	const said = sentencesOf(words)
		.filter(s => !FILLER.test(s))
		.map(s => s.replace(/[:：]$/, '.'))
		.filter(s => s.replace(/[.!?。！？]/g, '').trim().split(/\s+/).length > 1 || /[㐀-鿿]/.test(s));
	// "Here's what I'll do." on its own says nothing: the sentence after it does
	const lead = /^(here('|’)?s|here is|this is|the plan|my plan|plan|steps|i('|’)ll do (the following|this)|下面|计划|步骤)\b[^.!?。！？]{0,30}[.。]$/i;
	const kept = said.filter((s, i) => !(lead.test(s) && i < said.length - 1));
	return clip(kept.slice(0, 2).join(' '));
}

/** Two lines say the same when one holds the other once case, spaces and marks are set aside. */
export function sameWords(a: string, b: string): boolean {
	const k = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
	const x = k(a), y = k(b);
	return !!x && !!y && (x === y || (Math.min(x.length, y.length) > 12 && (x.includes(y) || y.includes(x))));
}

export interface INowWhyInput {
	/** The line the agent wrote with `dispatch now`, when it wrote it during this turn. */
	readonly own?: string;
	/** What the head's big line shows. */
	readonly say: string;
	/** What the agent wrote at the start of the turn before it did anything (openingWords). */
	readonly opening?: string;
}

/** The why line: the agent's `dispatch now` line when the head shows something else, else its opening words; never
 *  the head's own line again. Undefined: nothing the agent said, so nothing shows. */
export function nowWhy(i: INowWhyInput): { readonly text: string; readonly from: 'now' | 'plan' } | undefined {
	const own = i.own?.trim();
	if (own && !sameWords(own, i.say)) {
		return { text: clip(own), from: 'now' };
	}
	const opening = i.opening?.trim();
	if (opening && !sameWords(opening, i.say) && !(own && sameWords(opening, own))) {
		return { text: clip(opening), from: 'plan' };
	}
	return undefined;
}
