/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the passage a side chat was asked about, in the Docs tab's reader (direction A「Bottom-right card」,
 *  user 2026-11-15, task-23iin, kanban design/side-chat).
 *
 *  - The reader's Markdown says which file it shows (`.dispatch-docs-md[data-path]`, dispatchDocsEditor.ts) and the
 *    source lines of each block (`.md-block[data-line][data-end]`). The passage's words are found in its blocks and
 *    lit with the CSS highlight API: softly while its card is open, fully while the pointer is on the card's quote,
 *    and a click on the quote scrolls the reader back to it and lights it fully for a moment.
 *  - An answer kept as a comment (Keep as comment) is a row under its passage, with the passage's words underlined
 *    dotted: the row says the first line, a click opens the whole answer with Open side chat and Delete.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { renderMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { findPassage, IDocComment, ISideChatPassage, passageLine } from '../common/dispatchSideChatModel.js';

const SOFT = 'dispatch-side-chat-soft';
const STRONG = 'dispatch-side-chat-strong';
const COMMENTED = 'dispatch-doc-commented';

/** The Docs reader's Markdown for this file, when one is on screen. */
export function docReaderBody(doc: Document, path: string): HTMLElement | undefined {
	return [...doc.querySelectorAll<HTMLElement>('.dispatch-docs-md[data-path]')].find(b => b.dataset.path === path && b.getClientRects().length > 0);
}

/** The reader's blocks the passage's lines fall in, top to bottom. */
function passageBlocks(body: HTMLElement, start: number, end: number): HTMLElement[] {
	const blocks = [...body.querySelectorAll<HTMLElement>(':scope > .md-block')];
	const hit = blocks.filter(b => {
		const line = Number(b.dataset.line), last = Number(b.dataset.end ?? b.dataset.line);
		return line <= end && last >= start;
	});
	if (hit.length) {
		return hit;
	}
	// a passage whose first line is blank in the source: the block that comes before it
	const before = blocks.filter(b => Number(b.dataset.line) <= start).pop();
	return before ? [before] : [];
}

/** The passage's words in the reader as a Range; the whole blocks when the words are not found any more. */
export function passageRange(body: HTMLElement, p: Pick<ISideChatPassage, 'start' | 'end' | 'text'>): Range | undefined {
	const blocks = passageBlocks(body, p.start, p.end);
	if (!blocks.length) {
		return undefined;
	}
	const doc = body.ownerDocument;
	const nodes: Text[] = [];
	for (const b of blocks) {
		const walker = doc.createTreeWalker(b, NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			nodes.push(n as Text);
		}
	}
	const range = doc.createRange();
	// blocks are separate paragraphs: a space between their words, as the selection had a line break there
	let hay = '';
	const starts: number[] = [];
	let lastBlock: Element | null = null;
	for (const n of nodes) {
		const block = n.parentElement?.closest('.md-block') ?? null;
		if (lastBlock && block !== lastBlock) {
			hay += '\n';
		}
		lastBlock = block;
		starts.push(hay.length);
		hay += n.data;
	}
	const at = findPassage(hay, p.text);
	const locate = (offset: number, isEnd: boolean): [Text, number] | undefined => {
		for (let i = nodes.length - 1; i >= 0; i--) {
			if (starts[i] < offset || (!isEnd && starts[i] === offset)) {
				return [nodes[i], Math.min(nodes[i].data.length, offset - starts[i])];
			}
		}
		return nodes.length ? [nodes[0], 0] : undefined;
	};
	const a = at && locate(at.start, false), z = at && locate(at.end, true);
	if (a && z) {
		range.setStart(a[0], a[1]);
		range.setEnd(z[0], z[1]);
		return range;
	}
	range.setStartBefore(blocks[0].firstChild ?? blocks[0]);
	range.setEndAfter(blocks[blocks.length - 1].lastChild ?? blocks[blocks.length - 1]);
	return range;
}

/** How much the passage is lit: softly while its card is open, fully while the pointer is on the quote. */
export type PassageLight = 'none' | 'soft' | 'strong';

/** Lights the passage in the reader (one passage at a time per window). */
export function lightPassage(body: HTMLElement | undefined, p: Pick<ISideChatPassage, 'start' | 'end' | 'text'> | undefined, light: PassageLight, win: Window & typeof globalThis): void {
	const registry = win.CSS?.highlights;
	if (!registry) {
		return;
	}
	registry.delete(SOFT);
	registry.delete(STRONG);
	if (light === 'none' || !body || !p) {
		return;
	}
	const range = passageRange(body, p);
	if (range) {
		const hl = new win.Highlight(range);
		hl.priority = light === 'strong' ? 3 : 2;
		registry.set(light === 'strong' ? STRONG : SOFT, hl);
	}
}

/** Scrolls the reader so the passage is in the middle of it. */
export function scrollToPassage(body: HTMLElement, p: Pick<ISideChatPassage, 'start' | 'end'>, smooth: boolean): boolean {
	const first = passageBlocks(body, p.start, p.end)[0];
	if (!first) {
		return false;
	}
	first.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
	return true;
}

// ---- comments ---------------------------------------------------------------------------------------------------

/** What the reader asks about the comments; dispatchSideChat.contribution.ts answers. */
export interface IDocCommentsHost {
	readonly onDidChange: Event<void>;
	comments(path: string): readonly IDocComment[];
	remove(id: string): void;
	/** Opens the side chat the answer came from in its card. */
	openChat(chat: string): void;
}

export const docCommentsHost: { current?: IDocCommentsHost } = {};

const _onDidRenderDoc = new Emitter<string>();
/** The reader drew a document again (its passage's highlight went with the old page): the file's path. */
export const onDidRenderDoc: Event<string> = _onDidRenderDoc.event;

/** Draws the kept answers under their passages in the reader's Markdown, and again when they change. */
export function attachDocComments(body: HTMLElement, path: string): IDisposable {
	const host = docCommentsHost.current;
	if (!host) {
		_onDidRenderDoc.fire(path);
		return Disposable.None;
	}
	const store = new DisposableStore();
	const drawn = store.add(new DisposableStore());
	const open = new Set<string>();
	const win = dom.getWindow(body);
	const draw = () => {
		drawn.clear();
		body.querySelectorAll(':scope > .dispatch-doc-comment').forEach(e => e.remove());
		const underline = new win.Highlight();
		for (const c of host.comments(path)) {
			const blocks = passageBlocks(body, c.start, c.end);
			const last = blocks[blocks.length - 1];
			if (!last) {
				continue;
			}
			const range = passageRange(body, c);
			if (range) {
				underline.add(range);
			}
			drawn.add(drawComment(last, c, open, host));
		}
		win.CSS?.highlights?.set(COMMENTED, underline);
	};
	draw();
	store.add(host.onDidChange(draw));
	_onDidRenderDoc.fire(path);
	store.add(toDisposable(() => {
		win.CSS?.highlights?.delete(COMMENTED);
		body.querySelectorAll(':scope > .dispatch-doc-comment').forEach(e => e.remove());
	}));
	return store;
}

function drawComment(after: HTMLElement, c: IDocComment, open: Set<string>, host: IDocCommentsHost): IDisposable {
	const store = new DisposableStore();
	const el = dom.$('.dispatch-doc-comment', { 'data-comment': c.id });
	after.after(el);
	store.add(toDisposable(() => el.remove()));
	const head = dom.append(el, dom.$('button.dispatch-doc-comment-head', { type: 'button', 'aria-expanded': String(open.has(c.id)) }));
	dom.append(head, dom.$(`span.ic${ThemeIcon.asCSSSelector(Codicon.comment)}`, { 'aria-hidden': 'true' }));
	dom.append(head, dom.$('span.t', undefined, localize('dispatchSideChat.comment', "Comment")));
	dom.append(head, dom.$('span.s', undefined, passageLine(c.body.replace(/[#*_`>]/g, ''), 200)));
	dom.append(head, dom.$(`span.car${ThemeIcon.asCSSSelector(Codicon.chevronDown)}`, { 'aria-hidden': 'true' }));
	head.title = localize('dispatchSideChat.commentTip', "An answer from a side chat, kept on this passage");
	const full = dom.append(el, dom.$('.dispatch-doc-comment-body'));
	const md = store.add(renderMarkdown(new MarkdownString(c.body)));
	full.appendChild(md.element);
	const acts = dom.append(full, dom.$('.dispatch-doc-comment-acts'));
	if (c.chat) {
		const chat = c.chat;
		const go = dom.append(acts, dom.$('button.dispatch-side-chat-act', { type: 'button' }));
		dom.append(go, dom.$(`span${ThemeIcon.asCSSSelector(Codicon.commentDiscussion)}`, { 'aria-hidden': 'true' }));
		dom.append(go, dom.$('span', undefined, localize('dispatchSideChat.openChat', "Open side chat")));
		store.add(dom.addDisposableListener(go, dom.EventType.CLICK, e => { dom.EventHelper.stop(e, true); host.openChat(chat); }));
	}
	const del = dom.append(acts, dom.$('button.dispatch-side-chat-act', { type: 'button' }));
	dom.append(del, dom.$(`span${ThemeIcon.asCSSSelector(Codicon.trash)}`, { 'aria-hidden': 'true' }));
	dom.append(del, dom.$('span', undefined, localize('dispatchSideChat.deleteComment', "Delete")));
	store.add(dom.addDisposableListener(del, dom.EventType.CLICK, e => { dom.EventHelper.stop(e, true); host.remove(c.id); }));
	const toggle = (on: boolean) => {
		el.classList.toggle('open', on);
		head.setAttribute('aria-expanded', String(on));
		if (on) {
			open.add(c.id);
		} else {
			open.delete(c.id);
		}
	};
	toggle(open.has(c.id));
	store.add(dom.addDisposableListener(head, dom.EventType.CLICK, e => { dom.EventHelper.stop(e, true); toggle(!el.classList.contains('open')); }));
	// keep clicks in the comment from starting a selection of the document's words (and its Ask Question box)
	store.add(dom.addDisposableListener(el, dom.EventType.MOUSE_UP, e => e.stopPropagation()));
	return store;
}
