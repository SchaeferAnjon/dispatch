/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: task mentions in a chat reply become links (patches/330-task-links.patch;
 *  kanban design/task-model/DECISIONS.md: the person never reads task-xxxx).
 *
 *  After a reply renders, each mention {@link findTaskRefs} finds loses its id: 「仓库拆分修 Bug
 *  （task-2vcx）」 shows 「仓库拆分修 Bug」 as one link; **Title**（task-2vcx） links the bold title; a
 *  bare task-2vcx is replaced by the task's title from the board (`dispatch task show` through
 *  dispatch-bridge's `dispatch.tasks`); one the board does not know reads "a task" (a bracket is
 *  dropped). A click in a reply opens the task in place in the side pane's Tasks tab and the conversation
 *  stays (`dispatch.showTask`, task-86t0e); the reply's tasks are asked for as soon as it is drawn
 *  (dispatchTaskBriefs.ts), so the card is there at once. Where that command is not registered (the
 *  editor window) the reply is left alone. The Agents window's own pages and cards (Waiting for you, the
 *  task views, the sidebar's hovers) use the same links and open the task page (`_dispatch.openTask`).
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchPathLinks.css';
import * as dom from '../../../../../../base/browser/dom.js';
import { DisposableStore, IDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { dispatchTaskBriefs, type IDispatchTaskBrief } from '../../../common/dispatchTaskBriefs.js';
import { findTaskRefs, titleWrittenBefore } from './dispatchTaskRefs.js';

const OPEN_TASK = '_dispatch.openTask';
/** The side pane's Tasks tab opens the task in place (dispatchDocsOpen.ts). */
const SHOW_TASK = 'dispatch.showTask';
const SKIP_SELECTOR = 'a, pre, code, button, textarea, .monaco-editor, .interactive-result-code-block, .chat-inline-anchor-widget, .dispatch-path-link, .dispatch-task-link, .chat-codeblock-pill-widget';
const LABEL_ELEMENTS = new Set(['STRONG', 'B', 'EM', 'I']);

/** The board's answer for one task: brief, only the task, not the commit search (a page can name several tasks at once). */
export function askDispatchTaskBrief(commandService: ICommandService, id: string): Promise<IDispatchTaskBrief | undefined> {
	return commandService.executeCommand<IDispatchTaskBrief>('dispatch.tasks', { op: 'show', id, brief: true });
}

function taskTitle(commandService: ICommandService, id: string): Promise<string | undefined> {
	return dispatchTaskBriefs.get(id, i => askDispatchTaskBrief(commandService, i))
		.then(ans => ans && !ans.error && ans.title ? ans.title : undefined);
}

/** A chat reply: a click opens the task in the side pane's Tasks tab, the conversation stays (task-86t0e). */
export function linkifyDispatchTasks(accessor: ServicesAccessor, root: HTMLElement): IDisposable {
	return linkifyDispatchTasksWith(accessor.get(ICommandService), root, { inPlace: true });
}

/**
 * The text with every task mention as the person reads it: 「标题（task-2vcx）」 → 「标题」, a bare
 * task-2vcx → the task's title (or "a task" when the board does not know it). For text that cannot
 * hold a link (a quick pick's rows and title).
 */
export async function plainDispatchTaskRefs(commandService: ICommandService, text: string): Promise<string> {
	const refs = findTaskRefs(text);
	if (!refs.length) {
		return text;
	}
	const titles = await Promise.all(refs.map(r => r.bare ? taskTitle(commandService, r.id) : Promise.resolve(undefined)));
	let out = '';
	let at = 0;
	refs.forEach((r, i) => {
		out += text.slice(at, r.start);
		if (r.bare) {
			const title = titles[i] ?? localize('dispatchTaskLink.unknown', "a task");
			const written = titles[i] ? titleWrittenBefore(out, title) : -1;
			out = written >= 0 ? out.slice(0, out.length - written) + out.slice(out.length - written, out.length - written + title.trim().length)
				: out + (/[A-Za-z0-9.,;:!?)]$/.test(out) && !/^\s/.test(text.slice(r.start)) ? ' ' : '') + title;
		}
		at = r.end;
	});
	return out + text.slice(at);
}

/**
 * {@link linkifyDispatchTasks} for callers that hold the command service (the Agents window's own pages and cards):
 * a click opens the task page. `inPlace`: the side pane's Tasks tab instead, and the tasks are asked for at once.
 */
export function linkifyDispatchTasksWith(commandService: ICommandService, root: HTMLElement, options: { inPlace?: boolean } = {}): IDisposable {
	const store = new DisposableStore();
	const inPlace = !!options.inPlace && !!CommandsRegistry.getCommand(SHOW_TASK);
	if (!CommandsRegistry.getCommand(OPEN_TASK)) {
		return store;
	}
	const linked: string[] = [];
	let disposed = false;
	store.add({ dispose: () => { disposed = true; } });

	const link = (el: HTMLElement, id: string, title?: string) => {
		el.classList.add('dispatch-task-link', 'dispatch-path-link');
		el.setAttribute('role', 'link');
		el.tabIndex = 0;
		el.title = title ? localize('dispatchTaskLink.titled', "Open the task: {0}", title) : localize('dispatchTaskLink.title', "Open the task");
		el.dataset.task = id;
		linked.push(id);
		const open = (e: Event) => {
			const selection = dom.getWindow(el).getSelection();
			if (e.type === 'click' && selection && !selection.isCollapsed && selection.toString().trim()) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			if (inPlace) {
				// the words of the link are the title until the board's answer is there
				void commandService.executeCommand(SHOW_TASK, id, title || (el.textContent ?? '').trim());
			} else {
				void commandService.executeCommand(OPEN_TASK, id);
			}
		};
		store.add(dom.addDisposableListener(el, dom.EventType.CLICK, open));
		store.add(dom.addDisposableListener(el, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter') {
				open(e);
			}
		}));
	};

	// titles to look up: the placeholder spans waiting for the board's title
	const pending: { span: HTMLElement; id: string; original: string }[] = [];

	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		const parent = n.parentElement;
		if (parent && !parent.closest(SKIP_SELECTOR) && /task-[a-z0-9]{2,8}/.test(n.textContent ?? '')) {
			nodes.push(n as Text);
		}
	}
	for (const node of nodes) {
		const text = node.textContent ?? '';
		const refs = findTaskRefs(text);
		if (!refs.length) {
			continue;
		}
		const doc = node.ownerDocument;
		const frag = doc.createDocumentFragment();
		let at = 0;
		const emit = (to: number) => {
			if (to > at) {
				frag.appendChild(doc.createTextNode(text.slice(at, to)));
			}
		};
		for (const r of refs) {
			if (!r.bare && r.labelEnd > r.labelStart) {
				emit(r.labelStart);
				const span = doc.createElement('span');
				span.textContent = text.slice(r.labelStart, r.labelEnd);
				link(span, r.id);
				frag.appendChild(span);
				at = r.labelEnd;
				emit(r.start);
				at = r.end;
				continue;
			}
			if (!r.bare && text.slice(0, r.start).trim() === '' && labelElement(node)) {
				// **Title**（task-x）: the bold title is the link
				link(labelElement(node)!, r.id);
				emit(r.start);
				at = r.end;
				continue;
			}
			emit(r.start);
			const span = doc.createElement('span');
			const original = text.slice(r.start, r.end);
			// hidden until the board answers: the id never shows unless the board does not know it
			pending.push({ span, id: r.id, original: r.bare ? original : original.trim() });
			frag.appendChild(span);
			at = r.end;
		}
		emit(text.length);
		node.replaceWith(frag);
	}

	if (inPlace && linked.length) {
		// a click shows the task at once: ask for the reply's tasks now, a few at a time, behind any click
		dispatchTaskBriefs.prefetch(linked, i => askDispatchTaskBrief(commandService, i));
	}
	if (pending.length) {
		void Promise.all(pending.map(async p => ({ p, title: await taskTitle(commandService, p.id) }))).then(results => {
			if (disposed) {
				return;
			}
			for (const { p, title } of results) {
				// a span that left its text is gone for good; one not in the page yet (a hover card being built) still counts
				if (!p.span.parentNode) {
					continue;
				}
				if (title) {
					// after a Latin word the title keeps a space before it
					const prev = p.span.previousSibling;
					const before = prev?.textContent ?? '';
					const written = prev && prev.nodeType === 3 ? titleWrittenBefore(before, title) : -1;
					if (written >= 0) {
						// the title is written just before the id: those words are the link, shown once
						prev!.textContent = before.slice(0, before.length - written);
						p.span.textContent = before.slice(before.length - written, before.length - written + title.trim().length);
					} else {
						p.span.textContent = (/[A-Za-z0-9.,;:!?)]$/.test(before) ? ' ' : '') + title;
					}
					link(p.span, p.id, title);
				} else if (/^\s?[（(]/.test(p.original)) {
					// a bracket the board does not know: the words before it stay, the id goes
					p.span.remove();
				} else {
					// a bare id the board does not know (another Mac's, or removed): no id on screen either
					const before = p.span.previousSibling?.textContent ?? '';
					p.span.replaceWith(p.span.ownerDocument.createTextNode((/[A-Za-z0-9.,;:!?)]$/.test(before) ? ' ' : '') + localize('dispatchTaskLink.unknown', "a task")));
				}
			}
		});
	}
	return store;
}

function labelElement(node: Text): HTMLElement | undefined {
	const prev = node.previousSibling;
	return dom.isHTMLElement(prev) && LABEL_ELEMENTS.has(prev.tagName) && !prev.classList.contains('dispatch-task-link') && (prev.textContent ?? '').trim() ? prev : undefined;
}
