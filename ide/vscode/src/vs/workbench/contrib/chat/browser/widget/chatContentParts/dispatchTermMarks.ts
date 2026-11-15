/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Explain terms (learning while the agent works, the third part, user 2026-11-15, task-39x97, kanban
 *  design/learn-scene frame 4). In an agent's reply and in the Now tab, the first time a common developer word comes
 *  (worktree, commit, dependency…, the list in common/dispatchTerms.ts) it gets a faint dotted line under it; pointing
 *  at it, or reaching it with Tab, shows VS Code's own hover with one sentence for someone who does not program and
 *  "Ask more", which asks about the word in the side chat card (or quotes it into the conversation where side chats
 *  are not there; contrib/dispatchLearn's `_dispatch.learn.askTerm`). One reply marks a word once, over all its
 *  pieces of text. Settings › Learning › Explain terms switches it off: the lines go at once.
 *  Only in the Agents window (the ask command is there); the editor window's chat is left alone.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchTermMarks.css';
import * as dom from '../../../../../../base/browser/dom.js';
import { HoverPosition } from '../../../../../../base/browser/ui/hover/hoverWidget.js';
import { escapeMarkdownSyntaxTokens, MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { EXPLAIN_TERMS_SETTING, explainTermsOn, findTerms, IDispatchTerm } from '../../../common/dispatchTerms.js';
import { findPathCandidates } from './dispatchPathDetector.js';

/** `_dispatch.learn.askTerm({ term, plain })`: Ask more about a word (contrib/dispatchLearn). */
export const DISPATCH_ASK_TERM_COMMAND = '_dispatch.learn.askTerm';

const SKIP_SELECTOR = 'a, pre, code, button, textarea, kbd, h1, h2, h3, .monaco-editor, .interactive-result-code-block, .chat-inline-anchor-widget, .dispatch-path-link, .dispatch-task-link, .dispatch-pref-link, .dispatch-term, .chat-codeblock-pill-widget';
/** A bracket a preference's short name may be in (dispatchPrefs.ts links it later): no word inside it is marked. */
const BRACKET = /[（(][^（）()\n]{2,40}[）)]/g;

interface IClaim {
	readonly index: number;
	readonly terms: Set<string>;
}

/** Per reply: which of its pieces of text (by their place in the reply) marked which words. */
const claims = new Map<string, Set<IClaim>>();

function claimedBefore(reply: string, index: number): Set<string> {
	const out = new Set<string>();
	for (const c of claims.get(reply) ?? []) {
		if (c.index < index) {
			c.terms.forEach(t => out.add(t));
		}
	}
	return out;
}

/** Whether marks are drawn in this window: the Agents window has the command Ask more runs. */
export function dispatchTermsHere(): boolean {
	return !!CommandsRegistry.getCommand(DISPATCH_ASK_TERM_COMMAND);
}

export interface ITermMarkServices {
	readonly hoverService: IHoverService;
	readonly commandService: ICommandService;
	readonly configurationService: IConfigurationService;
}

let watching: IDisposable | undefined;
/** Explain terms switched: every mark on screen follows at once (no line, no hover, no Tab stop when off). */
function watchSetting(configurationService: IConfigurationService, doc: Document): void {
	if (watching) {
		return;
	}
	watching = configurationService.onDidChangeConfiguration(e => {
		if (!e.affectsConfiguration(EXPLAIN_TERMS_SETTING)) {
			return;
		}
		const on = explainTermsOn(configurationService.getValue(EXPLAIN_TERMS_SETTING));
		// eslint-disable-next-line no-restricted-syntax
		for (const el of doc.querySelectorAll<HTMLElement>('.dispatch-term')) {
			setOn(el, on);
		}
	});
}

function setOn(el: HTMLElement, on: boolean): void {
	el.classList.toggle('off', !on);
	el.tabIndex = on ? 0 : -1;
	if (on) {
		el.setAttribute('role', 'button');
		el.setAttribute('aria-description', el.dataset.plain ?? '');
	} else {
		el.removeAttribute('role');
		el.removeAttribute('aria-description');
	}
}

/**
 * Marks the words of `root`: each at its first place in the reply (`reply`, the piece's place in it `index`); pieces
 * earlier in the same reply keep theirs. The marks go when the returned disposable is disposed (the piece drawn again).
 */
export function markDispatchTermsWith(s: ITermMarkServices, root: HTMLElement, reply: string, index: number): IDisposable {
	const store = new DisposableStore();
	if (!dispatchTermsHere()) {
		return store;
	}
	watchSetting(s.configurationService, root.ownerDocument);
	const claimed = claimedBefore(reply, index);
	const claim: IClaim = { index, terms: new Set() };
	let set = claims.get(reply);
	if (!set) {
		set = new Set();
		claims.set(reply, set);
	}
	set.add(claim);
	store.add(toDisposable(() => {
		const all = claims.get(reply);
		all?.delete(claim);
		if (all && !all.size) {
			claims.delete(reply);
		}
	}));

	const on = explainTermsOn(s.configurationService.getValue(EXPLAIN_TERMS_SETTING));
	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		const parent = n.parentElement;
		if (parent && !parent.closest(SKIP_SELECTOR) && (n.textContent ?? '').trim().length > 1) {
			nodes.push(n as Text);
		}
	}
	const seen = new Set([...claimed]);
	for (const node of nodes) {
		const text = node.textContent ?? '';
		// a path in it is linked later by dispatchPathLinks.ts, which holds on to this very node: left alone
		if (/[./]/.test(text) && findPathCandidates(text).length) {
			continue;
		}
		const brackets = [...text.matchAll(BRACKET)].map(m => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
		const found = findTerms(text, seen).filter(f => !brackets.some(([a, b]) => f.start < b && f.end > a));
		if (!found.length) {
			continue;
		}
		const doc = node.ownerDocument;
		const frag = doc.createDocumentFragment();
		let at = 0;
		for (const f of found) {
			if (f.start > at) {
				frag.appendChild(doc.createTextNode(text.slice(at, f.start)));
			}
			const span = doc.createElement('span');
			span.className = 'dispatch-term';
			span.textContent = text.slice(f.start, f.end);
			span.dataset.term = f.term.term;
			span.dataset.plain = f.term.plain;
			setOn(span, on);
			store.add(hoverOn(s, span, f.term));
			frag.appendChild(span);
			claim.terms.add(f.term.term);
			at = f.end;
		}
		if (at < text.length) {
			frag.appendChild(doc.createTextNode(text.slice(at)));
		}
		node.replaceWith(frag);
	}
	return store;
}

/** A reply's piece of text, from the chat's markdown part. */
export function markDispatchTerms(accessor: ServicesAccessor, root: HTMLElement, reply: string, index: number): IDisposable {
	return markDispatchTermsWith({
		hoverService: accessor.get(IHoverService),
		commandService: accessor.get(ICommandService),
		configurationService: accessor.get(IConfigurationService),
	}, root, reply, index);
}

/** VS Code's hover: the word, one sentence, and Ask more; after the usual delay when pointed at, at once on Tab. */
function hoverOn(s: ITermMarkServices, span: HTMLElement, term: IDispatchTerm): IDisposable {
	const store = new DisposableStore();
	const options = () => ({
		// one paragraph that breaks at spaces (appendText turns every space into a non-breaking one)
		content: new MarkdownString(`**${escapeMarkdownSyntaxTokens(term.term)}** · ${escapeMarkdownSyntaxTokens(term.plain)}`),
		additionalClasses: ['dispatch-term-hover'],
		position: { hoverPosition: HoverPosition.BELOW },
		appearance: { showPointer: true },
		actions: [{
			label: localize('dispatchTerms.askMore', "Ask more"),
			commandId: DISPATCH_ASK_TERM_COMMAND,
			run: () => {
				s.hoverService.hideHover(true);
				void s.commandService.executeCommand(DISPATCH_ASK_TERM_COMMAND, { term: term.term, plain: term.plain });
			},
		}],
	});
	const live = () => !span.classList.contains('off') && explainTermsOn(s.configurationService.getValue(EXPLAIN_TERMS_SETTING));
	store.add(dom.addDisposableListener(span, dom.EventType.MOUSE_OVER, () => {
		if (live()) {
			s.hoverService.showDelayedHover({ ...options(), target: span }, { groupId: 'dispatch-term' });
		}
	}));
	// Enter or Space on the word: the hover takes the keyboard, Ask more is a Tab away
	store.add(dom.addDisposableListener(span, dom.EventType.KEY_DOWN, e => {
		if (live() && (e.key === 'Enter' || e.key === ' ')) {
			e.preventDefault();
			// the hover Tab showed is the same one: shown again, now with the keyboard in it
			s.hoverService.hideHover(true);
			s.hoverService.showInstantHover({ ...options(), target: span }, true);
		}
	}));
	// Tab onto the word: the sentence at once, the keyboard stays on the word
	store.add(dom.addDisposableListener(span, dom.EventType.FOCUS, () => {
		if (live() && span.matches(':focus-visible')) {
			s.hoverService.showInstantHover({ ...options(), target: span }, false);
		}
	}));
	store.add(dom.addDisposableListener(span, dom.EventType.BLUR, e => {
		// into the hover (Ask more) it stays; anywhere else it goes
		const to = e.relatedTarget as HTMLElement | null;
		if (!to || !to.closest('.dispatch-term-hover')) {
			s.hoverService.hideHover();
		}
	}));
	return store;
}
