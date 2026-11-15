/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a quote the person picked with Quote (⇧⌘L) before writing their message (kanban
 *  design/quote/redesign 方向 B「引用当附件」; patches/315-quote.patch).
 *
 *  In the input and above the sent bubble a quote is a card of its own; the bubble keeps only what
 *  the person typed. It travels as a Simple attachment with display kind
 *  {@link DispatchQuoteDisplayKind}: `_meta` under {@link DispatchQuoteMetadataKey} holds the text
 *  and where it came from, so the card can be drawn again and clicked back to its source. The Claude,
 *  Codex and OpenCode harnesses call {@link applyDispatchQuotes}: the agent reads the quotes as `>`
 *  paragraphs in front of the message (a file or diff line first names `file:line`), one blank line,
 *  then the person's words.
 *--------------------------------------------------------------------------------------------*/

import { MessageAttachmentKind, type MessageAttachment } from '../state/protocol/state.js';

export const DispatchQuoteMetadataKey = 'dispatch.quote';
export const DispatchQuoteDisplayKind = 'dispatchQuote';

/** A quote longer than this is cut, and its last line is `> …`. */
export const DISPATCH_QUOTE_MAX_LINES = 20;
export const DISPATCH_QUOTE_MAX_CHARS = 1500;

export type DispatchQuoteFrom = 'reply' | 'file' | 'diff';

export interface IDispatchQuoteSource {
	readonly from: DispatchQuoteFrom;
	/** What the card's second line says: `Claude · 4:20 AM`, or `NOTES.md:9`. */
	readonly label: string;
	/** Codicon id for the second line (the agent's mark, a file, the Changes icon). */
	readonly icon?: string;
	/** reply: the chat resource and the response the text was selected in. */
	readonly chat?: string;
	readonly responseId?: string;
	readonly requestId?: string;
	/** file / diff: the file, the other side of the diff, the path the agent knows it by, 1-based lines. */
	readonly uri?: string;
	readonly originalUri?: string;
	readonly file?: string;
	readonly startLine?: number;
	readonly endLine?: number;
	/** When it was said (ms), for the reply's time. */
	readonly at?: number;
}

export interface IDispatchQuoteMeta {
	readonly v: 1;
	readonly text: string;
	readonly source: IDispatchQuoteSource;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
	return typeof v === 'string' && v ? v : undefined;
}

function num(v: unknown): number | undefined {
	return typeof v === 'number' && isFinite(v) ? v : undefined;
}

/** The quote an attachment (or chat variable) carries in `_meta`, or undefined. */
export function readDispatchQuoteMeta(holder: { readonly _meta?: Record<string, unknown> } | undefined): IDispatchQuoteMeta | undefined {
	const raw = holder?._meta?.[DispatchQuoteMetadataKey];
	if (!isRecord(raw) || typeof raw.text !== 'string' || !raw.text.trim() || !isRecord(raw.source)) {
		return undefined;
	}
	const s = raw.source;
	const from: DispatchQuoteFrom = s.from === 'file' || s.from === 'diff' ? s.from : 'reply';
	return {
		v: 1,
		text: raw.text,
		source: {
			from,
			label: str(s.label) ?? '',
			icon: str(s.icon),
			chat: str(s.chat),
			responseId: str(s.responseId),
			requestId: str(s.requestId),
			uri: str(s.uri),
			originalUri: str(s.originalUri),
			file: str(s.file),
			startLine: num(s.startLine),
			endLine: num(s.endLine),
			at: num(s.at),
		},
	};
}

export function toDispatchQuoteMeta(meta: IDispatchQuoteMeta): Record<string, unknown> {
	return { [DispatchQuoteMetadataKey]: meta };
}

/** `NOTES.md:9` or `NOTES.md:9-12` for a file or diff quote; undefined for a reply. */
export function dispatchQuoteLocation(source: IDispatchQuoteSource): string | undefined {
	if (source.from === 'reply' || !source.file) {
		return undefined;
	}
	if (source.startLine === undefined) {
		return source.file;
	}
	const end = source.endLine ?? source.startLine;
	return end > source.startLine ? `${source.file}:${source.startLine}-${end}` : `${source.file}:${source.startLine}`;
}

/** The quoted text as `>` lines, cut at {@link DISPATCH_QUOTE_MAX_LINES} lines or {@link DISPATCH_QUOTE_MAX_CHARS} characters. */
export function toQuoteLines(text: string): string {
	let lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
	let cut = lines.length > DISPATCH_QUOTE_MAX_LINES;
	lines = lines.slice(0, DISPATCH_QUOTE_MAX_LINES);
	let joined = lines.join('\n');
	if (joined.length > DISPATCH_QUOTE_MAX_CHARS) {
		joined = joined.slice(0, DISPATCH_QUOTE_MAX_CHARS);
		cut = true;
	}
	return joined.split('\n').map(line => line ? `> ${line}` : '>').join('\n') + (cut ? '\n> …' : '');
}

/**
 * What the agent reads for one quote:
 *
 *     NOTES.md:9
 *     > Subtasks: the parent task is already counted once.
 */
export function renderDispatchQuoteText(meta: IDispatchQuoteMeta): string {
	const where = dispatchQuoteLocation(meta.source);
	const body = toQuoteLines(meta.text);
	return where ? `${where}\n${body}` : body;
}

export function isDispatchQuoteAttachment(att: MessageAttachment): boolean {
	return att.type === MessageAttachmentKind.Simple && att.displayKind === DispatchQuoteDisplayKind;
}

/**
 * Takes the quote attachments out of `attachments` and puts them in front of `prompt`: each quote's
 * `>` paragraph in the order they were added, a blank line between them, a blank line, the prompt.
 */
export function applyDispatchQuotes<T extends MessageAttachment>(prompt: string, attachments: readonly T[] | undefined): { prompt: string; attachments: T[] | undefined } {
	if (!attachments?.length) {
		return { prompt, attachments: attachments ? [...attachments] : undefined };
	}
	const quotes: string[] = [];
	const rest: T[] = [];
	for (const att of attachments) {
		if (!isDispatchQuoteAttachment(att)) {
			rest.push(att);
			continue;
		}
		const meta = readDispatchQuoteMeta(att);
		const text = meta ? renderDispatchQuoteText(meta) : (att.type === MessageAttachmentKind.Simple ? att.modelRepresentation : undefined);
		if (text?.trim()) {
			quotes.push(text);
		}
	}
	if (!quotes.length) {
		return { prompt, attachments: rest };
	}
	const head = quotes.join('\n\n');
	return { prompt: prompt.trim() ? `${head}\n\n${prompt}` : head, attachments: rest };
}
