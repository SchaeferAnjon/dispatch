/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: where a quote's words are in the conversation (patches/315-quote.patch).
 *
 *  - While the pointer is on a quote card, the words it came from light up in a neutral grey (the CSS
 *    custom highlight `dispatch-quote-source`, the chat's own selection highlight works the same way).
 *  - A click on a card scrolls back to that reply and flashes the words for 2 s (DESIGN.md 「搜索命中
 *    闪一下」's length and curve; from the fill colour at 24%, since it sits under the words).
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { foreground } from '../../../../platform/theme/common/colorRegistry.js';
import { buttonBackground } from '../../../../platform/theme/common/colors/inputColors.js';
import { IColorTheme, registerThemingParticipant } from '../../../../platform/theme/common/themeService.js';
import { IChatWidget } from '../../../../workbench/contrib/chat/browser/chat.js';

const hoverHighlightName = 'dispatch-quote-source';
const flashHighlightName = 'dispatch-quote-flash';

let flashColor: { r: number; g: number; b: number } = { r: 37, g: 37, b: 37 };

// A highlight pseudo-element only sees custom properties on the root, so the colour is baked in.
registerThemingParticipant((theme: IColorTheme, collector) => {
	const fg = theme.getColor(foreground);
	if (fg) {
		collector.addRule(`::highlight(${hoverHighlightName}) { background-color: ${fg.transparent(0.09)}; }`);
	}
	const fill = theme.getColor(buttonBackground);
	if (fill) {
		flashColor = { r: fill.rgba.r, g: fill.rgba.g, b: fill.rgba.b };
	}
});

function highlightIn(win: Window & typeof globalThis, name: string): Highlight | undefined {
	const registry = win.CSS?.highlights;
	if (!registry) {
		return undefined;
	}
	let h = registry.get(name);
	if (!h) {
		h = new win.Highlight();
		registry.set(name, h);
	}
	return h;
}

/** The row of the transcript that shows `responseId`, when it is rendered. */
function rowOf(widget: IChatWidget, responseId: string): HTMLElement | undefined {
	// eslint-disable-next-line no-restricted-syntax
	for (const row of widget.transcriptDomNode.querySelectorAll<HTMLElement>('.interactive-item-container')) {
		if (widget.getElementFromNode(row)?.id === responseId) {
			return row;
		}
	}
	return undefined;
}

/**
 * The DOM range of `text` in the reply's rendered markdown. White space does not count (a selection
 * across paragraphs has line breaks the text nodes do not), so the words are matched one character at a
 * time with the gaps skipped.
 */
export function findQuoteRange(widget: IChatWidget, responseId: string | undefined, text: string): Range | undefined {
	const needle = text.replace(/\s+/g, '');
	if (!needle || !responseId) {
		return undefined;
	}
	const row = rowOf(widget, responseId);
	if (!row) {
		return undefined;
	}
	const doc = row.ownerDocument;
	const nodes: Text[] = [];
	// eslint-disable-next-line no-restricted-syntax
	for (const part of row.querySelectorAll<HTMLElement>('.chat-markdown-part')) {
		const walker = doc.createTreeWalker(part, NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			if (!(n.parentElement?.closest('.monaco-editor, .chat-tool-invocation-part'))) {
				nodes.push(n as Text);
			}
		}
	}
	// the haystack without white space, and where each of its characters is
	const chars: { node: Text; offset: number }[] = [];
	let hay = '';
	for (const node of nodes) {
		const data = node.data;
		for (let i = 0; i < data.length; i++) {
			if (!/\s/.test(data[i])) {
				hay += data[i];
				chars.push({ node, offset: i });
			}
		}
	}
	const at = hay.indexOf(needle);
	if (at < 0) {
		return undefined;
	}
	const start = chars[at];
	const end = chars[at + needle.length - 1];
	const range = doc.createRange();
	range.setStart(start.node, start.offset);
	range.setEnd(end.node, end.offset + 1);
	return range;
}

/** Light the words while the pointer is on the card; the returned disposable turns it off. */
export function showQuoteSource(widget: IChatWidget, responseId: string | undefined, text: string): IDisposable | undefined {
	const range = findQuoteRange(widget, responseId, text);
	const h = range && highlightIn(dom.getWindow(widget.domNode), hoverHighlightName);
	if (!range || !h) {
		return undefined;
	}
	h.add(range);
	return toDisposable(() => h.delete(range));
}

/** Scroll the transcript so the words sit a third of the way down, then flash them for 2 s. */
export function revealAndFlash(widget: IChatWidget, responseId: string, text: string): void {
	const item = widget.viewModel?.getItems().find(i => i.id === responseId);
	if (!item) {
		return;
	}
	const hold = widget.holdAutoScroll();
	widget.reveal(item);
	const win = dom.getWindow(widget.domNode);
	win.requestAnimationFrame(() => win.requestAnimationFrame(() => {
		const range = findQuoteRange(widget, responseId, text);
		if (!range) {
			hold.dispose();
			return;
		}
		const box = range.getBoundingClientRect();
		const view = widget.transcriptDomNode.getBoundingClientRect();
		if (box.top < view.top + 24 || box.bottom > view.bottom - 24) {
			// the chat widget scrolls by its list; IChatWidget does not say so, ChatWidget has the setter
			const scrollable = widget as unknown as { scrollTop: number };
			scrollable.scrollTop = scrollable.scrollTop + (box.top - view.top) - view.height / 3;
		}
		win.requestAnimationFrame(() => flash(win, findQuoteRange(widget, responseId, text) ?? range, () => hold.dispose()));
	}));
}

let flashStyle: HTMLStyleElement | undefined;
let flashFrame = 0;

function flash(win: Window & typeof globalThis, range: Range, done: () => void): void {
	const h = highlightIn(win, flashHighlightName);
	if (!h) {
		done();
		return;
	}
	h.clear();
	h.add(range);
	if (!flashStyle || flashStyle.ownerDocument !== win.document) {
		flashStyle = win.document.createElement('style');
		win.document.head.appendChild(flashStyle);
	}
	const style = flashStyle;
	const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
	const duration = 2000;
	const t0 = win.performance.now();
	win.cancelAnimationFrame(flashFrame);
	const paint = (alpha: number) => {
		style.textContent = `::highlight(${flashHighlightName}) { background-color: rgba(${flashColor.r}, ${flashColor.g}, ${flashColor.b}, ${alpha.toFixed(3)}); }`;
	};
	const step = (now: number) => {
		const t = Math.min(1, (now - t0) / duration);
		// ease-in-out, 24% down to nothing; with reduced motion it holds, then goes
		const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
		paint(reduced ? (t < 0.9 ? 0.24 : 0) : 0.24 * (1 - eased));
		if (t < 1) {
			flashFrame = win.requestAnimationFrame(step);
		} else {
			h.clear();
			style.textContent = '';
			done();
		}
	};
	paint(0.24);
	flashFrame = win.requestAnimationFrame(step);
}
