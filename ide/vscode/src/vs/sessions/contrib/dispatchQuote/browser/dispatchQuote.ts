/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Quote and Ask Question on a selection (kanban design/quote/redesign 方向 B「引用当
 *  附件」; patches/315-quote.patch). The three boxes that pop up on a selection (a reply, the
 *  Markdown editor, a diff in Changes) all offer the same two things, in the same order:
 *
 *  - Quote (⇧⌘L): the selection becomes a card above the chat input's text; several can pile up. The
 *    agent reads them as `>` paragraphs in front of the message (dispatchQuoteAttachmentMeta.ts).
 *  - Ask Question: a side chat about the selection, like the reply's own Ask Question box.
 *
 *  This file holds what the boxes share: the labels, the chat variable for a quote, and putting it in
 *  the chat input.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { hash } from '../../../../base/common/hash.js';
import { isMacintosh, language } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IDispatchQuoteMeta, IDispatchQuoteSource, toDispatchQuoteMeta } from '../../../../platform/agentHost/common/meta/dispatchQuoteAttachmentMeta.js';
import { IChatWidget } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IChatRequestDispatchQuoteVariableEntry } from '../../../../workbench/contrib/chat/common/attachments/chatVariableEntries.js';

/** Quote a selection into the active session's chat input: {@link IDispatchQuoteFileArgs}. */
export const DISPATCH_QUOTE_COMMAND = '_dispatch.quoteSelection';
/** Ask about a selection in a side chat: {@link IDispatchQuoteFileArgs} plus an optional question. */
export const DISPATCH_ASK_COMMAND = '_dispatch.askAboutSelection';
/** Go back to where a quote came from: an {@link IDispatchQuoteMeta}. */
export const DISPATCH_REVEAL_QUOTE_COMMAND = '_dispatch.revealQuoteSource';

/** Quote a selection in a file or a diff (the Markdown editor, Changes, Docs). Lines and columns are 1-based. */
export interface IDispatchQuoteFileArgs {
	readonly uri: string;
	readonly startLineNumber: number;
	readonly startColumn?: number;
	readonly endLineNumber: number;
	readonly endColumn?: number;
	readonly text: string;
	/** Defaults to 'file'. */
	readonly from?: 'file' | 'diff';
	/** A diff's other side, so a click on the card opens the diff again. */
	readonly originalUri?: string;
	/** Ask Question: what was typed in the box; empty opens the side chat to type in. */
	readonly question?: string;
	/** Asked in the Docs tab's reader: the side chat card's quote scrolls the reader back to the passage. */
	readonly inDocs?: boolean;
}

export const QUOTE_KEYBINDING_LABEL = isMacintosh ? '⇧⌘L' : 'Ctrl+Shift+L';

export const quoteIcon: ThemeIcon = Codicon.quote;
export const askIcon: ThemeIcon = Codicon.commentDiscussion;

export function quoteLabel(): string {
	return localize('dispatchQuote.quote', "Quote");
}

export function quoteTitle(): string {
	return localize('dispatchQuote.quoteTitle', "Quote ({0})", QUOTE_KEYBINDING_LABEL);
}

export function askLabel(): string {
	return localize('dispatchQuote.ask', "Ask Question");
}

export function askTitle(): string {
	return localize('dispatchQuote.askTitle', "Ask Question in a side chat");
}

/** The first line with words on it, for the card and the attachment's name. */
export function firstLine(text: string): string {
	return text.split(/\r?\n/).map(l => l.trim()).find(l => !!l) ?? text.trim();
}

/** `4:20 AM` */
export function formatQuoteTime(ms: number | undefined): string {
	if (ms === undefined) {
		return '';
	}
	try {
		return new Date(ms).toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' });
	} catch {
		return new Date(ms).toLocaleTimeString();
	}
}

/** `Claude`, `Codex`, `OpenCode` from a session type or provider id; undefined when it is none of them. */
export function agentName(...hints: (string | undefined)[]): string | undefined {
	const hint = hints.filter(Boolean).join(' ').toLowerCase();
	if (hint.includes('claude')) {
		return 'Claude';
	}
	if (hint.includes('codex') || hint.includes('openai')) {
		return 'Codex';
	}
	if (hint.includes('opencode')) {
		return 'OpenCode';
	}
	return undefined;
}

export function toQuoteEntry(text: string, source: IDispatchQuoteSource): IChatRequestDispatchQuoteVariableEntry {
	const meta: IDispatchQuoteMeta = { v: 1, text, source };
	const where = source.from === 'reply' ? `${source.chat}#${source.responseId}` : `${source.uri}:${source.startLine}-${source.endLine}`;
	return {
		kind: 'dispatchQuote',
		id: `dispatchQuote:${hash(`${where}\n${text}`)}`,
		name: firstLine(text),
		value: text,
		_meta: toDispatchQuoteMeta(meta),
	};
}

/** Put the quote in the widget's input (once: the same selection quoted again stays one card) and focus it. */
export function addQuoteToWidget(widget: IChatWidget, entry: IChatRequestDispatchQuoteVariableEntry): void {
	if (!widget.attachmentModel.attachments.some(a => a.id === entry.id)) {
		widget.attachmentModel.addContext(entry);
	}
	widget.focusInput();
}
