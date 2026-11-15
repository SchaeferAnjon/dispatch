/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: in the Agents window the message you sent, once it has scrolled away above, is pinned as one quiet
 *  line at the top of the conversation (user 2026-11-15, task-wdjpl, design/sticky-ask B). VS Code's own sticky scroll
 *  still decides which message is pinned; this marks the pinned row so dispatch-shell.css draws it as that line, and a
 *  click (or Enter / Space) scrolls smoothly back to the message instead of starting to edit it.
 *  It fades in and out in 150 ms (user 2026-11-15, task-vk9nq,「钉住那一行出现要丝滑」): dispatch-shell.css fades it
 *  in as it is drawn or uncovered; a line taken away while shown (another message pinned, a jump to the top) leaves a
 *  copy here that fades out; the same message drawn again in place comes back without a fade.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';

/** How the pinned line reaches the transcript it belongs to (the chat widget's own scroll position). */
export interface IDispatchStickyAskScroller {
	scrollTop: number;
	/** Where the message's row starts, in the same space as scrollTop; undefined once it is gone. */
	messageTop(): number | undefined;
	/** The conversation (one per chat widget) and the message pinned, to tell a redraw from a new line. */
	readonly owner: object;
	readonly requestId: string;
}

const SCROLL_MS = 240;
const FADE_MS = 150;

/** The line each conversation showed when it was last taken away, until the redraw that may follow in the same task. */
const leaving = new WeakMap<object, { requestId: string; ghost: HTMLElement | undefined }>();

/** Whether the row's line is hidden (its message on screen) and since when, to tell how far its fade has got. */
interface IFade {
	hidden: boolean;
	since: number;
}

const PARTIAL = 'source-node-partially-visible';

export function attachDispatchStickyAsk(stickyRow: HTMLElement, scroller: IDispatchStickyAskScroller): IDisposable {
	const store = new DisposableStore();
	stickyRow.classList.add('dispatch-sticky-ask');
	const win = dom.getWindow(stickyRow);
	// drawn shown, it fades in from now (dispatch-shell.css @starting-style); drawn hidden, there is nothing to fade
	const fade: IFade = { hidden: stickyRow.classList.contains(PARTIAL), since: stickyRow.classList.contains(PARTIAL) ? -Infinity : win.performance.now() };
	// VS Code toggles the class as the message comes into view or leaves it; a class change is all this watches
	const watch = new win.MutationObserver(() => noteFade(stickyRow, fade));
	watch.observe(stickyRow, { attributes: true, attributeFilter: ['class'] });
	store.add(toDisposable(() => watch.disconnect()));
	// the same message drawn again in place (VS Code redraws the pinned row when its size settles): no fade, no ghost
	const left = leaving.get(scroller.owner);
	if (left?.requestId === scroller.requestId) {
		fade.since = -Infinity;
		left.ghost = undefined;
		stickyRow.classList.add('dispatch-sticky-ask-steady');
		const handle = win.requestAnimationFrame(() => win.requestAnimationFrame(() => stickyRow.classList.remove('dispatch-sticky-ask-steady')));
		store.add(toDisposable(() => win.cancelAnimationFrame(handle)));
	}
	store.add(toDisposable(() => {
		noteFade(stickyRow, fade);
		leaveBehind(stickyRow, scroller, fade);
		stickyRow.classList.remove('dispatch-sticky-ask', 'dispatch-sticky-ask-steady');
	}));
	const back = (e: Event) => {
		e.preventDefault();
		e.stopPropagation();
		scrollBack(stickyRow, scroller);
	};
	store.add(dom.addDisposableListener(stickyRow, dom.EventType.CLICK, back, true));
	store.add(dom.addDisposableListener(stickyRow, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
		if (e.key === 'Enter' || e.key === ' ') {
			back(e);
		}
	}, true));
	return store;
}

function noteFade(stickyRow: HTMLElement, fade: IFade): void {
	const hidden = stickyRow.classList.contains(PARTIAL);
	if (hidden !== fade.hidden) {
		fade.hidden = hidden;
		fade.since = dom.getWindow(stickyRow).performance.now();
	}
}

/** Called as VS Code takes the row away (it is still in the page). A line that is shown, or still fading out, leaves a
 *  copy that fades out from where its own fade has got, unless the same message is drawn again before this task ends
 *  (then the new row takes over as it is). */
function leaveBehind(stickyRow: HTMLElement, scroller: IDispatchStickyAskScroller, fade: IFade): void {
	const container = stickyRow.parentElement;
	const parent = container?.parentElement;
	const win = dom.getWindow(stickyRow);
	const elapsed = win.performance.now() - fade.since;
	if (!container || !parent || (fade.hidden && elapsed >= FADE_MS)) {
		return;
	}
	const entry: { requestId: string; ghost: HTMLElement | undefined } = { requestId: scroller.requestId, ghost: undefined };
	if (!fade.hidden) {
		leaving.set(scroller.owner, entry);
	}
	queueMicrotask(() => {
		if (leaving.get(scroller.owner) === entry) {
			leaving.delete(scroller.owner);
		}
		const ghost = entry.ghost;
		if (!ghost) {
			return;
		}
		parent.appendChild(ghost);
		const remove = () => ghost.remove();
		ghost.addEventListener('animationend', remove, { once: true });
		win.setTimeout(remove, FADE_MS * 3);
	});
	if (stickyRow.closest('.monaco-reduce-motion') || win.matchMedia('(prefers-reduced-motion: reduce)').matches) {
		return;
	}
	// a container of its own: VS Code hides its container (display: none) once nothing is pinned
	const ghost = dom.$('.monaco-tree-sticky-container.dispatch-sticky-ask-ghost');
	ghost.setAttribute('aria-hidden', 'true');
	ghost.style.height = container.style.height;
	const copy = stickyRow.cloneNode(true) as HTMLElement;
	copy.removeAttribute('id');
	copy.classList.remove('dispatch-sticky-ask-steady', PARTIAL);
	// carry on from the opacity the line had: part way through fading out, or not yet fully faded in
	const done = fade.hidden ? elapsed : (elapsed < FADE_MS ? FADE_MS - elapsed : 0);
	copy.style.setProperty('--dispatch-sticky-ask-out-delay', `${-Math.round(done)}ms`);
	ghost.appendChild(copy);
	entry.ghost = ghost;
}

/** The pinned row is drawn again as the list scrolls, so the scroll runs on its own, not on the row's lifetime. */
function scrollBack(stickyRow: HTMLElement, scroller: IDispatchStickyAskScroller): void {
	const from = scroller.scrollTop;
	const target = scroller.messageTop();
	if (target === undefined) {
		return;
	}
	const win = dom.getWindow(stickyRow);
	if (stickyRow.closest('.monaco-reduce-motion') || Math.abs(target - from) < 1) {
		scroller.scrollTop = target;
		return;
	}
	const start = Date.now();
	const step = () => {
		const t = Math.min(1, (Date.now() - start) / SCROLL_MS);
		const eased = 1 - Math.pow(1 - t, 3);
		// rows above may settle their heights on the way: aim at where the message is now
		const to = scroller.messageTop() ?? target;
		scroller.scrollTop = from + (to - from) * eased;
		if (t < 1) {
			win.requestAnimationFrame(step);
		}
	};
	win.requestAnimationFrame(step);
}
