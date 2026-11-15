/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: "Key saved: NAME — what it is for", whoever saved it (kanban task-d5ejn; the person's preference
 *  "存 key 有提示"). The same toast as "Preference remembered" (chat dispatchPrefs.ts): inverted, 38 high, 8 s, held
 *  while the pointer is on it, several merged into one, its own classes so it looks the same. Show opens
 *  Settings › Keys at the key's row; Undo takes the change back (`dispatch env undo`: the old value again, or the
 *  new key gone).
 *
 *  Where it comes from: every `dispatch env set / unset` writes a line without the value to
 *  ~/.dispatch/state/env-events.jsonl (kanban app/cli/env_changes.py); dispatch-bridge watches it and calls
 *  `_dispatch.envChanged` with the new lines (ide-ext/src/keys.ts). So an agent's `dispatch env set` in a chat, one
 *  typed in Dispatch's terminal and a Save on the Keys page all end here. The Keys page shows its own at once and
 *  the bridge's copy of it is skipped by id.
 *
 *  Where it shows: above the input of the session on screen, in its flow like the preference toast, so the
 *  conversation makes room; anywhere else (the new-session page, Settings, a terminal) over the bottom of the window,
 *  taking no room.
 *  The value is never in it: only the name and the purpose.
 *--------------------------------------------------------------------------------------------*/

import '../../../../workbench/contrib/chat/browser/widget/chatContentParts/media/dispatchPrefs.css';
import './media/dispatchSettingsKeys.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { DISPATCH_SETTINGS_OPEN } from './dispatchSettingsState.js';

const TOAST_MS = 8000;
const DONE_MS = 3000;
export const KEYS_COMMAND = 'dispatch.env';

/** One line of env-events.jsonl: what changed, never the value. */
export interface IKeyEvent {
	readonly id: string;
	readonly op: 'set' | 'edit' | 'unset' | 'undo';
	readonly name: string;
	readonly note: string;
	readonly project?: string;
	readonly by?: string;
	readonly created?: boolean;
}

export interface IKeysAnswer<T = unknown> { readonly ok: boolean; readonly result?: T; readonly error?: string }

// ---- the store changed (any of the ways in): an open Keys page reads its list again ----------------------------

const onDidChange = new Emitter<readonly IKeyEvent[]>();
export const onDidChangeDispatchKeys = onDidChange.event;

/** Events already toasted (the page's own, then the bridge's copy of it). */
const shown = new Set<string>();

CommandsRegistry.registerCommand('_dispatch.envChanged', (accessor: ServicesAccessor, events?: unknown) => {
	const list = Array.isArray(events) ? events.filter(isKeyEvent) : [];
	onDidChange.fire(list);
	showKeysToast(accessor, list);
});

function isKeyEvent(e: unknown): e is IKeyEvent {
	const x = e as IKeyEvent;
	return !!x && typeof x.id === 'string' && typeof x.name === 'string' && typeof x.op === 'string';
}

// ---- the toast --------------------------------------------------------------------------------------------------

interface IToast {
	slot: HTMLElement;
	readonly el: HTMLElement;
	events: IKeyEvent[];
	timer: ReturnType<typeof setTimeout> | undefined;
	left: number;
	started: number;
	/** Show was used: it pointed at its keys, a key saved after that gets a toast of its own. */
	used?: boolean;
	readonly store: DisposableStore;
}

let current: IToast | undefined;
let layoutService: ILayoutService | undefined;

/** The bottom of the window, over whatever is on screen. */
function floatSlot(layout: ILayoutService): HTMLElement {
	const container = layout.mainContainer;
	let slot = container.querySelector<HTMLElement>(':scope > .dispatch-keys-toast-float');
	if (!slot) {
		slot = DOM.append(container, DOM.$('.dispatch-keys-toast-float'));
	}
	return slot;
}

/** Above the input of the session on screen, else at the bottom of the window. */
function slotFor(widgets: IChatWidgetService, layout: ILayoutService): HTMLElement {
	const onScreen = (el: HTMLElement | undefined) => !!el && el.isConnected && el.getClientRects().length > 0;
	const all = widgets.getAllWidgets();
	const widget = [widgets.lastFocusedWidget, ...all].find(w => w && onScreen(w.input?.element));
	const input = widget?.input?.element;
	if (input) {
		let slot = input.querySelector<HTMLElement>(':scope > .dispatch-keys-toast-slot');
		if (!slot) {
			slot = DOM.$('.dispatch-keys-toast-slot');
			input.prepend(slot);
		}
		return slot;
	}
	// the new-session page (its box is not a chat widget) and everything else: over the window's bottom, taking no room,
	// so the place pickers and the box do not move
	return floatSlot(layout);
}

function headOf(events: readonly IKeyEvent[]): { head: string; rest: string } {
	if (events.length === 1) {
		const e = events[0];
		const head = e.op === 'unset' ? localize('dispatchKeys.toastDeleted', "Key deleted:") : localize('dispatchKeys.toastSaved', "Key saved:");
		return { head, rest: e.note ? `${e.name} — ${e.note}` : e.name };
	}
	const names = events.slice(0, 2).map(e => e.name).join(', ');
	const more = events.length > 2 ? localize('dispatchKeys.andMore', " and {0} more", events.length - 2) : '';
	const deleted = events.filter(e => e.op === 'unset').length;
	return {
		head: deleted === events.length ? localize('dispatchKeys.toastDeletedMany', "{0} keys deleted:", events.length)
			: deleted ? localize('dispatchKeys.toastChangedMany', "{0} keys changed:", events.length)
				: localize('dispatchKeys.toastSavedMany', "{0} keys saved:", events.length),
		rest: names + more,
	};
}

function close(t: IToast): void {
	if (t.timer) {
		clearTimeout(t.timer);
	}
	t.store.dispose();
	t.el.classList.add('out');
	const done = () => {
		t.el.remove();
		if (!t.slot.childElementCount && t.slot.classList.contains('dispatch-keys-toast-float')) {
			t.slot.remove();
		}
		if (current === t) {
			current = undefined;
		}
	};
	const reduced = DOM.getWindow(t.el).matchMedia?.('(prefers-reduced-motion: reduce)').matches;
	if (reduced) {
		done();
	} else {
		setTimeout(done, 200);
	}
}

function arm(t: IToast, ms: number): void {
	if (t.timer) {
		clearTimeout(t.timer);
	}
	t.left = ms;
	t.started = Date.now();
	t.timer = setTimeout(() => close(t), ms);
}

function say(t: IToast, ic: ThemeIcon, text: string): void {
	DOM.clearNode(t.el);
	t.store.clear();
	DOM.append(t.el, DOM.$('span.icon' + ThemeIcon.asCSSSelector(ic)));
	DOM.append(t.el, DOM.$('span.tt', undefined, text));
	arm(t, DONE_MS);
}

function render(t: IToast, commands: ICommandService): void {
	const { head, rest } = headOf(t.events);
	DOM.clearNode(t.el);
	t.store.clear();
	t.el.dataset.keys = t.events.map(e => e.name).join(' ');
	DOM.append(t.el, DOM.$('span.icon' + ThemeIcon.asCSSSelector(Codicon.key)));
	const text = DOM.append(t.el, DOM.$('span.tt'));
	DOM.append(text, DOM.$('b', undefined, head));
	text.append(` ${rest}`);
	t.el.title = t.events.map(e => e.note ? `${e.name}: ${e.note}` : e.name).join('\n');
	const button = (label: string, kind: string, run: () => void) => {
		const b = DOM.append(t.el, DOM.$('button.tb', { type: 'button' }, label));
		b.dataset.toast = kind;
		t.store.add(DOM.addDisposableListener(b, DOM.EventType.CLICK, e => { e.preventDefault(); run(); }));
	};
	if (t.events.some(e => e.op !== 'unset')) {
		// the toast stays, so Undo is still there next to the row it points at: the session's input it sat above
		// is gone behind Settings, so it moves to the bottom of the window
		button(localize('dispatchKeys.show', "Show"), 'show', () => {
			const last = [...t.events].reverse().find(e => e.op !== 'unset');
			t.used = true;
			arm(t, TOAST_MS);
			void Promise.resolve(commands.executeCommand(DISPATCH_SETTINGS_OPEN, 'keys', last ? `key:${last.name}` : undefined)).finally(() => {
				DOM.getWindow(t.el).requestAnimationFrame(() => {
					if (t.el.isConnected && !t.el.getClientRects().length && layoutService) {
						const slot = floatSlot(layoutService);
						slot.appendChild(t.el);
						t.slot = slot;
					}
				});
			});
		});
	}
	button(localize('dispatchKeys.undo', "Undo"), 'undo', () => {
		const events = [...t.events].reverse();
		void (async () => {
			const failed: string[] = [];
			for (const e of events) {
				const ans = await commands.executeCommand<IKeysAnswer>(KEYS_COMMAND, 'undo', { change: e.id }).catch(() => undefined);
				if (!ans?.ok) {
					failed.push(ans?.error || localize('dispatchKeys.undoFailed', "{0} could not be undone.", e.name));
				}
			}
			if (failed.length) {
				say(t, Codicon.warning, failed[0]);
			} else if (events.length === 1) {
				const e = events[0];
				say(t, Codicon.discard, e.op === 'unset'
					? localize('dispatchKeys.undoneBack', "Undone: {0} is back", e.name)
					: e.created
						? localize('dispatchKeys.undoneGone', "Undone: {0} removed", e.name)
						: localize('dispatchKeys.undoneOld', "Undone: {0} has its old value again", e.name));
			} else {
				say(t, Codicon.discard, localize('dispatchKeys.undoneMany', "Undone: {0} changes", events.length));
			}
		})();
	});
}

/** Show (or add to) the toast for these changes. Undo's own change and ones already shown are skipped. */
/**
 * A new change to the keys is on its way: the toast about the change before it goes now. Its Undo would take back
 * that earlier change, and for the second or two the new one takes it read as the new one's (a delete was "undone"
 * and the key before it lost instead; 2026-11-12, task-cq11p).
 */
export function closeKeysToast(): void {
	if (current) {
		close(current);
	}
}

export function showKeysToast(accessor: ServicesAccessor, events: readonly IKeyEvent[]): void {
	const fresh = events.filter(e => (e.op === 'set' || e.op === 'edit' || e.op === 'unset') && !shown.has(e.id));
	if (!fresh.length) {
		return;
	}
	for (const e of fresh) {
		shown.add(e.id);
	}
	const commands = accessor.get(ICommandService);
	layoutService = accessor.get(ILayoutService);
	const slot = slotFor(accessor.get(IChatWidgetService), layoutService);
	// saves merge with saves, deletes with deletes; the other kind takes the toast's place ("2 keys saved" must not
	// count a delete)
	const gone = (e: IKeyEvent) => e.op === 'unset';
	const sameKind = !!current && current.events.every(e => gone(e) === gone(fresh[0])) && fresh.every(e => gone(e) === gone(fresh[0]));
	let t = current && sameKind && !current.used && current.slot === slot && current.el.isConnected && !current.el.classList.contains('out') ? current : undefined;
	if (t) {
		t.events = [...t.events, ...fresh];
	} else {
		if (current) {
			close(current);
		}
		const el = DOM.append(slot, DOM.$('.dispatch-prefs-toast.dispatch-keys-toast', { role: 'status', 'aria-live': 'polite' }));
		t = { slot, el, events: [...fresh], timer: undefined, left: TOAST_MS, started: Date.now(), store: new DisposableStore() };
		current = t;
		const tt = t;
		// held while the pointer is on it
		el.addEventListener('mouseenter', () => { if (tt.timer) { clearTimeout(tt.timer); tt.timer = undefined; tt.left = Math.max(1500, tt.left - (Date.now() - tt.started)); } });
		el.addEventListener('mouseleave', () => arm(tt, tt.left));
	}
	render(t, commands);
	arm(t, TOAST_MS);
}
