/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Waiting for you, the data (kanban design/task-model/DECISIONS.md, design/waiting/redesign
 *  direction A). What waits for the person across every project comes from `dispatch waiting --json`
 *  through dispatch-bridge (`dispatch.waiting`); dispatchWaiting.ts polls it into `dispatchWaitingData`.
 *  The Waiting for you row, its hover card, the page, the queue bar over a session and the session rows
 *  (sessionsList.ts) read it from here.
 *
 *  What the person just handled on the page (Allow, a picked option, Mark read, Done, Not now) leaves at
 *  once: its id is hidden until a poll no longer lists it (or comes back after 30 s: then it did not take),
 *  and every count here already leaves it out.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, derived, IObservable, observableValue } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
// the card's styles (every card of ours shares them), and holding a card open under the reason card
import { holdDispatchHoverCard } from '../../../../workbench/browser/dispatchHoverCard.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { isDesignDecide, type IDispatchWaitingWeek, splitWaiting, type WaitingThing, waitingThing, waitingThingName } from './dispatchWaitingGroups.js';
import { DispatchBlockIcons } from '../../dispatchBlocks/browser/dispatchBlocks.js';
import { stateMark } from '../../dispatchBlocks/browser/dispatchMarks.js';

export type DispatchWaitingKind = 'approve' | 'decide' | 'unread' | 'only_you';
export type DispatchWaitingScope = 'outside_workspace' | 'uploads' | 'destructive';

/**
 * An option of a Decide row: an agent's question has `id` and `label`; a design direction from
 * `dispatch flow design` (kanban app/cli/flows.py) has `key` (A, B) and `title`.
 */
export interface IDispatchWaitingOption {
	readonly id?: string;
	readonly label?: string;
	readonly key?: string;
	readonly title?: string;
}

/** What picking the option sends: the question's option id, or the direction's letter. */
export function waitingOptionId(o: IDispatchWaitingOption): string {
	return o.id ?? o.key ?? '';
}

/** The option in words: the question's label, or "A: Now reading on top". */
export function waitingOptionLabel(o: IDispatchWaitingOption): string {
	if (o.label) {
		return o.label;
	}
	return o.title ? `${o.key}: ${o.title}` : o.key ?? '';
}

/**
 * What a waiting thing is, as an icon: the first slot of a row in the side bar and on the page (DESIGN.md 符号表, user
 * 2026-11-12, task-he465: every row there waits for the person, so the slot says what the thing is instead of
 * repeating the state), and the row of the hover cards (a project's, the Projects page's line). One table: the same
 * thing has the same icon everywhere. Only a real proposal page gets Dispatch's proposal glyph; an engine's question
 * with options is a question.
 */
const THING_ICON: Record<WaitingThing, ThemeIcon> = {
	proposal: DispatchBlockIcons.proposal,
	question: Codicon.question,
	approval: Codicon.shield,
	'only-you': Codicon.person,
};

export function waitingIcon(item: IDispatchWaitingItem): ThemeIcon {
	return THING_ICON[waitingThing(item)];
}

/** The 14px icon in a row's first slot, named for screen readers ("Proposal", "Question", "Approval", "Only you"). */
export function renderWaitingThingIcon(parent: HTMLElement, item: IDispatchWaitingItem): HTMLElement {
	const icon = DOM.append(parent, renderIcon(waitingIcon(item)));
	icon.classList.add('dispatch-wait-kind');
	icon.dataset.thing = waitingThing(item);
	icon.setAttribute('role', 'img');
	icon.setAttribute('aria-label', waitingThingName(item));
	return icon;
}

/** A design direction to pick: computed with the rest of what a thing is (dispatchWaitingGroups.ts). */
export { isDesignDecide };

export interface IDispatchWaitingItem {
	/** `ide:<session uri>`, `chat:<agent>:<id>`, `task:<task id>` */
	readonly id: string;
	readonly kind: DispatchWaitingKind;
	readonly source: 'ide' | 'chat' | 'board';
	/** The Agents window's own session uri (`claude:/<id>`), for `ide` rows. */
	readonly resource?: string;
	/** A session row: `<agent>:<id>`. An Only-you task: the conversation it came from (its id). */
	readonly session?: string;
	readonly agent?: string;
	/** Only you: the task. A session row: the task it works on. */
	readonly task?: string;
	readonly task_title?: string;
	readonly title: string;
	readonly project: string;
	readonly project_dir?: string;
	/** The action in its own words, the question, the summary's first sentence, or the task's first line. */
	readonly phrase: string;
	readonly description?: string;
	readonly story?: string;
	readonly summary?: string;
	/** epoch seconds: when a session stopped, when an Only-you task was filed */
	readonly at: number;
	readonly stopped_at?: number;
	readonly created_at?: number;
	/** A task (Only you, Decide): when it was last edited. */
	readonly updated_at?: number;
	/** Only you: hidden by Not now until then (epoch seconds). */
	readonly snooze_until?: number;
	/** Only you: filed in the last seven days. */
	readonly recent?: boolean;
	readonly from_task?: string;
	/** approve: the tool, its command or path, the file it touches, where it reaches. */
	readonly tool?: string;
	readonly arg?: string;
	readonly path?: string;
	readonly scope?: DispatchWaitingScope | null;
	/** decide: the question and the options the card offers (none: answer it in the session). */
	readonly question?: string;
	readonly options?: readonly IDispatchWaitingOption[];
	/** decide, a design direction: the prototype Open shows in the side pane. */
	readonly open?: string;
	readonly actions: readonly string[];
}

export interface IDispatchWaitingCounts {
	readonly approve: number;
	readonly decide: number;
	readonly unread: number;
	readonly only_you: number;
	readonly only_you_recent: number;
	readonly only_you_older: number;
	/** Only-you tasks filed (or back from Not now) since the page was last opened. */
	readonly only_you_new: number;
	/** The sidebar row's number: approve + decide + unread + only_you_new. */
	readonly attention: number;
	readonly all: number;
}

export interface IDispatchWaitingData {
	readonly items: readonly IDispatchWaitingItem[];
	readonly counts?: IDispatchWaitingCounts;
	/** When the page was last opened (`dispatch waiting seen`). */
	readonly seen_at?: number;
	readonly updated_at: number;
	/** Sources that did not answer this time ("ide": an Agents window): their rows are missing, not gone. */
	readonly partial?: readonly string[];
}

// ---- the data, and what the page already took away -----------------------------------------------

const data = observableValue<IDispatchWaitingData | undefined>('dispatchWaitingData', undefined);
/** What `dispatch waiting` said last (raw: use {@link dispatchWaitingVisible} to show it). */
export const dispatchWaitingData: IObservable<IDispatchWaitingData | undefined> = data;

const HIDE_MS = 30_000;
const hidden = observableValue<ReadonlyMap<string, number>>('dispatchWaitingHidden', new Map());
/** Rows an Undo brought back, shown until a poll lists them again (a poll already on its way would drop them). */
const restored = observableValue<ReadonlyMap<string, { readonly item: IDispatchWaitingItem; readonly at: number }>>('dispatchWaitingRestored', new Map());

export function setDispatchWaitingData(value: IDispatchWaitingData | undefined): void {
	const before = data.get();
	// a source that did not answer this poll keeps the rows the last one gave (a slow answer is not "nothing waits";
	// rows would vanish and come back 5 s later): an Agents window ('ide'), the task board ('board': Decide, Only you)
	const missing: readonly string[] = (value?.partial ?? []).filter(p => p === 'ide' || p === 'board');
	if (value && missing.length && before) {
		const items = sortWaiting([...before.items.filter(i => missing.includes(i.source)), ...value.items.filter(i => !missing.includes(i.source))]);
		const counted = countWaiting(items, value.seen_at ?? 0);
		const onlyNew = value.counts?.only_you_new ?? counted.only_you_new;
		value = { ...value, items, counts: { ...counted, only_you_new: onlyNew, attention: counted.approve + counted.decide + counted.unread + onlyNew } };
	}
	// a handled row the poll no longer lists is gone for good; one it still lists after 30 s did not take
	const now = Date.now();
	const ids = new Set((value?.items ?? []).map(i => i.id));
	const keep = new Map([...hidden.get()].filter(([id, at]) => ids.has(id) && now - at < HIDE_MS));
	if (keep.size !== hidden.get().size) {
		hidden.set(keep, undefined);
	}
	// a row brought back that the poll lists again is back for good; one it still misses after 30 s did not come back
	const back = new Map([...restored.get()].filter(([id, r]) => !ids.has(id) && now - r.at < HIDE_MS));
	if (back.size !== restored.get().size) {
		restored.set(back, undefined);
	}
	data.set(value, undefined);
}

/** Take rows off the list at once (the page handled them); the next polls confirm it. */
export function hideDispatchWaitingItems(ids: readonly string[]): void {
	const next = new Map(hidden.get());
	for (const id of ids) {
		next.set(id, Date.now());
	}
	hidden.set(next, undefined);
}

/** An action that failed: the rows come back. */
export function unhideDispatchWaitingItems(ids: readonly string[]): void {
	const next = new Map(hidden.get());
	for (const id of ids) {
		next.delete(id);
	}
	hidden.set(next, undefined);
}

const KIND_ORDER: Record<DispatchWaitingKind, number> = { approve: 0, decide: 1, unread: 2, only_you: 3 };

/** The CLI's order: approve and decide the longest waiting first, unread and Only you the newest first. */
export function sortWaiting(items: readonly IDispatchWaitingItem[]): IDispatchWaitingItem[] {
	const at = (i: IDispatchWaitingItem) => i.kind === 'only_you' ? (i.created_at ?? i.at ?? 0) : (i.stopped_at ?? i.at ?? 0);
	return [...items].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
		|| (a.kind === 'approve' || a.kind === 'decide' ? at(a) - at(b) : at(b) - at(a)));
}

/** Undo: the rows come back at once, in their places (the next poll, after the bridge has undone it, says the same). */
export function restoreDispatchWaitingItems(items: readonly IDispatchWaitingItem[]): void {
	unhideDispatchWaitingItems(items.map(i => i.id));
	const next = new Map(restored.get());
	for (const item of items) {
		next.set(item.id, { item, at: Date.now() });
	}
	restored.set(next, undefined);
}

export function countWaiting(items: readonly IDispatchWaitingItem[], seenAt: number): IDispatchWaitingCounts {
	const n = (k: DispatchWaitingKind) => items.filter(i => i.kind === k).length;
	const only = items.filter(i => i.kind === 'only_you');
	const onlyNew = only.filter(i => (i.created_at ?? i.at ?? 0) > seenAt).length;
	const recent = only.filter(i => i.recent).length;
	return {
		approve: n('approve'), decide: n('decide'), unread: n('unread'), only_you: only.length,
		only_you_recent: recent, only_you_older: only.length - recent, only_you_new: onlyNew,
		attention: n('approve') + n('decide') + n('unread') + onlyNew, all: items.length,
	};
}

/** The data as the window shows it: without what the page already handled, counts to match. */
export const dispatchWaitingVisible: IObservable<IDispatchWaitingData | undefined> = derived(reader => {
	const value = data.read(reader);
	const gone = hidden.read(reader);
	const back = restored.read(reader);
	if (!value) {
		return undefined;
	}
	const listed = new Set(value.items.map(i => i.id));
	const extra = [...back.values()].map(r => r.item).filter(i => !listed.has(i.id) && !gone.has(i.id));
	if (!gone.size && !extra.length) {
		return value.counts ? value : { ...value, counts: countWaiting(value.items, value.seen_at ?? 0) };
	}
	const items = sortWaiting([...value.items.filter(i => !gone.has(i.id)), ...extra]);
	const counts = countWaiting(items, value.seen_at ?? 0);
	// the CLI's only_you_new also counts the ones back from Not now: keep that, minus what the page took, plus what came back
	const seen = value.seen_at ?? 0;
	const isNew = (i: IDispatchWaitingItem) => i.kind === 'only_you' && (i.created_at ?? 0) > seen;
	const onlyNew = value.counts
		? Math.max(0, value.counts.only_you_new - value.items.filter(i => gone.has(i.id) && isNew(i)).length + extra.filter(isNew).length)
		: counts.only_you_new;
	return { ...value, items, counts: { ...counts, only_you_new: onlyNew, attention: counts.approve + counts.decide + counts.unread + onlyNew } };
});

/**
 * The 7-day rule on what the window shows (dispatchWaitingGroups.ts): this week's things, the newest first, are the
 * sidebar's rows and its number and the page's This week; the rest is Older. Every poll recomputes it, so a thing
 * crosses the line within one poll of turning seven days old.
 */
export const dispatchWaitingWeek: IObservable<IDispatchWaitingWeek | undefined> = derived(reader => {
	const value = dispatchWaitingVisible.read(reader);
	return value ? splitWaiting(value.items) : undefined;
});

/** `claude:/abc`, `agent-host-claude:/abc`, `vscode-agent-host-claude://local/abc` → `claude/abc`. */
export function waitingSessionKey(resource: URI | string | undefined): string | undefined {
	if (!resource) {
		return undefined;
	}
	const text = typeof resource === 'string' ? resource : resource.toString();
	const m = /^([a-z][\w+.-]*):\/*(.*)$/i.exec(text.trim());
	if (!m) {
		return undefined;
	}
	const provider = m[1].toLowerCase().replace(/^(vscode-)?agent-host-/, '');
	const id = decodeURIComponent(m[2].split(/[?#]/)[0]).split('/').filter(Boolean).pop();
	return id ? `${provider}/${id}` : undefined;
}

/** The waiting row of an Agents-window session, if there is one. */
export function findWaitingItem(value: IDispatchWaitingData | undefined, resource: URI): IDispatchWaitingItem | undefined {
	const key = waitingSessionKey(resource);
	if (!value || !key) {
		return undefined;
	}
	return value.items.find(item => item.source === 'ide' && waitingSessionKey(item.resource) === key);
}

/** What a row is called: its title; never a task id (the person never reads task-xxxx). */
export function waitingTitle(item: IDispatchWaitingItem): string {
	return item.title || item.task_title || (item.kind === 'only_you' ? localize('dispatchWaiting.untitledTask', "Untitled task") : localize('dispatchWaiting.untitledSession', "Untitled session"));
}

/** The one line of detail a row carries: the tool and its argument, the question, the summary, the task's first line. */
export function waitingDetail(item: IDispatchWaitingItem): string {
	if (item.kind === 'approve' && item.arg) {
		// a command says what it does by itself ("xcrun notarytool …"); a file needs its verb ("Write ~/.config/…")
		return item.tool && item.tool !== 'Bash' ? `${item.tool} ${item.arg}` : item.arg;
	}
	if (item.kind === 'decide' && item.question) {
		return item.question;
	}
	return item.phrase;
}

// ---- time, the way each kind means it ------------------------------------------------------------

function minutes(s: number): number {
	return Math.max(1, Math.floor(s / 60));
}

/** Approve / Decide: how long the agent has been standing still ("waiting 14 min", "waiting 3 h"). */
export function waitingFor(at: number | undefined, now = Date.now() / 1000): string {
	const s = Math.max(0, now - (at ?? now));
	if (s < 3600) {
		return localize('dispatchWaiting.waitingMin', "waiting {0} min", minutes(s));
	}
	if (s < 86400) {
		return localize('dispatchWaiting.waitingHours', "waiting {0} h", Math.floor(s / 3600));
	}
	return localize('dispatchWaiting.waitingDays', "waiting {0} d", Math.floor(s / 86400));
}

// ---- the hover card (the Waiting for you row, and the same rows on a project's and a session's) ----

export interface IDispatchHoverRow {
	/** The waiting item the row stands for: pointing at it shows it on the page too (dispatchWaitingHover). */
	readonly id?: string;
	/** A category icon (Waiting for you's kinds), or a task's status as its state mark (DESIGN.md「符号表」). */
	readonly icon?: ThemeIcon;
	readonly dot?: 'todo' | 'in_progress' | 'waiting' | 'done';
	readonly title: string;
	readonly detail?: string;
	readonly onClick?: () => void;
}

/**
 * One row of the left sidebar's hover cards (design/waiting/redesign: the row's hover card): an icon,
 * the title, "· its detail" in grey; 28 high, taller when the text wraps. Clickable when `onClick` is given.
 */
export function renderHoverRow(parent: HTMLElement, row: IDispatchHoverRow, store?: DisposableStore): HTMLElement {
	const $ = DOM.$;
	const el = DOM.append(parent, $(row.onClick ? 'button.dispatch-hover-row.clickable' : '.dispatch-hover-row'));
	if (row.onClick) {
		(el as HTMLButtonElement).type = 'button';
	}
	const lead = DOM.append(el, $('span.dispatch-hover-lead'));
	if (row.icon) {
		lead.appendChild(renderIcon(row.icon));
	} else {
		const status = row.dot ?? 'todo';
		const mark = DOM.append(lead, stateMark(status === 'in_progress' ? 'now' : status));
		mark.classList.add('dispatch-task-mark');
		mark.dataset.status = status;
	}
	// the title and its detail as one text that wraps: a detail card cuts nothing off
	const body = DOM.append(el, $('span.dispatch-hover-body'));
	DOM.append(body, $('span.dispatch-hover-title', undefined, row.title));
	if (row.detail) {
		DOM.append(body, $('span.dispatch-hover-detail', undefined, `\u00a0· ${row.detail}`));
	}
	if (row.onClick) {
		const click = row.onClick;
		const listener = DOM.addDisposableListener(el, DOM.EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			click();
		});
		store?.add(listener);
	}
	if (row.id && store) {
		// the same item on the page and in this card: pointing at one shows the other
		const id = row.id;
		el.dataset.id = id;
		store.add(DOM.addDisposableListener(el, DOM.EventType.MOUSE_ENTER, () => { if (!el.hasAttribute('data-dispatch-detail-row')) { enterWaitingHover(id, 'card'); } }));
		store.add(DOM.addDisposableListener(el, DOM.EventType.MOUSE_LEAVE, () => { if (!el.hasAttribute('data-dispatch-detail-row')) { leaveWaitingHover(id); } }));
		store.add(autorun(reader => {
			const h = dispatchWaitingHover.read(reader);
			el.classList.toggle('linked', h?.from === 'page' && h.id === id);
		}));
		store.add(toDisposable(() => { if (!el.hasAttribute('data-dispatch-detail-row')) { leaveWaitingHover(id); } }));
	}
	return el;
}

/** What a card's button does with a waiting item: Allow, Deny, or pick an option (a direction's A or B). */
export type DispatchWaitingAnswer = { readonly act: 'allow' | 'deny' } | { readonly act: 'pick'; readonly option: IDispatchWaitingOption };

/**
 * The buttons of a waiting item on a hover card, the page's own (Waiting for you) in their small size: an
 * approval's Deny and Allow at the right, a decision's options at the left (a design direction's A and B).
 * Nothing else: the card's first row opens the item (its prototype, its task, its session). None when the
 * card cannot answer it (a question without options is answered in its session).
 */
export function renderWaitingHoverActions(parent: HTMLElement, item: IDispatchWaitingItem, answer: (a: DispatchWaitingAnswer) => void, store: DisposableStore): HTMLElement | undefined {
	const $ = DOM.$;
	const approve = item.kind === 'approve' && item.actions.includes('allow');
	const options = item.kind === 'decide' && item.actions.includes('pick') ? item.options ?? [] : [];
	if (!approve && !options.length) {
		return undefined;
	}
	const bar = DOM.append(parent, $('.dispatch-hover-actions'));
	const button = (label: string, cls: string, run: () => void) => {
		const b = DOM.append(bar, $<HTMLButtonElement>(`button.dispatch-waiting-btn.xs.${cls}`, { type: 'button' }));
		DOM.append(b, $('span', undefined, label));
		store.add(DOM.addDisposableListener(b, DOM.EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			run();
		}));
	};
	if (approve) {
		DOM.append(bar, $('span.dispatch-hover-sp'));
		button(localize('dispatchWaiting.deny', "Deny"), 'ghost', () => answer({ act: 'deny' }));
		button(localize('dispatchWaiting.allow', "Allow"), 'outline', () => answer({ act: 'allow' }));
	}
	for (const o of options) {
		button(waitingOptionLabel(o), 'outline', () => answer({ act: 'pick', option: o }));
	}
	return bar;
}

/**
 * Why this direction (optional), asked right where it was picked, not in a box at the top of the window: a
 * second card of the same look, right under `anchor` (the hover card the direction was picked on, or the
 * Decide card on the Waiting for you page), with one line to type in. Enter takes it ('' when nothing was
 * typed), Esc or a click elsewhere drops the pick (undefined). The card it hangs off stays open meanwhile.
 */
export function askPickReason(hoverService: IHoverService, anchor: HTMLElement, option: IDispatchWaitingOption): Promise<string | undefined> {
	const $ = DOM.$;
	return new Promise<string | undefined>(resolve => {
		const store = new DisposableStore();
		let settled = false;
		const card = $('.dispatch-hover-card.dispatch-reason-card');
		const head = DOM.append(card, $('.dispatch-hover-head'));
		DOM.append(head, $('span.dispatch-hover-head-name', undefined, localize('dispatchWaiting.pickTitle', "Pick {0}", waitingOptionLabel(option))));
		const box = DOM.append(card, $('.dispatch-reason-box'));
		const input = DOM.append(box, $<HTMLInputElement>('input.dispatch-reason-input', { type: 'text' }));
		input.placeholder = localize('dispatchWaiting.pickReason', "Why this one? Optional");
		input.setAttribute('aria-label', localize('dispatchWaiting.pickReason', "Why this one? Optional"));
		DOM.append(card, $('.dispatch-hover-note', undefined, localize('dispatchWaiting.pickNote', "Goes into your design preferences · Enter to pick, Esc to cancel")));
		store.add(holdDispatchHoverCard(anchor));
		let widget: { isDisposed: boolean; dispose(): void } | undefined;
		const finish = (value: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			resolve(value);
			if (widget && !widget.isDisposed) {
				widget.dispose();
			}
			store.dispose();
		};
		store.add(DOM.addDisposableListener(input, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.isComposing) {
				e.preventDefault();
				e.stopPropagation();
				finish(input.value.trim());
			} else if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				finish(undefined);
			}
		}));
		if (anchor.closest('.dispatch-hover-detail-panel')) {
			// a second card right under the details (user 09-28: "the reason can be a second floating card below"),
			// the details keep their size
			const panel = anchor.closest<HTMLElement>('.dispatch-hover-detail-panel')!;
			card.classList.add('dispatch-reason-attached', 'dispatch-reason-second');
			(anchor.ownerDocument.querySelector('.monaco-workbench') ?? anchor.ownerDocument.body).appendChild(card);
			const place = () => {
				const r = panel.getBoundingClientRect();
				card.style.width = `${r.width}px`;
				card.style.left = `${r.left}px`;
				const h = card.getBoundingClientRect().height;
				const below = r.bottom + 6;
				card.style.top = `${below + h > mainWindow.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below}px`;
			};
			place();
			widget = { isDisposed: false, dispose: () => card.remove() };
			store.add(DOM.addDisposableListener(anchor.ownerDocument, 'mousedown', (e: MouseEvent) => {
				if (DOM.isHTMLElement(e.target) && !anchor.contains(e.target) && !card.contains(e.target)) { finish(undefined); }
			}, true));
			const watch = mainWindow.setInterval(() => { if (!panel.isConnected) { finish(undefined); } else { place(); } }, 150);
			store.add(toDisposable(() => mainWindow.clearInterval(watch)));
			input.focus();
			return;
		}
		widget = hoverService.showInstantHover({
			content: card,
			target: anchor,
			position: { hoverPosition: HoverPosition.BELOW },
			appearance: { showPointer: false, skipFadeInAnimation: true },
			persistence: { sticky: true, hideOnHover: false },
			additionalClasses: ['dispatch-text-hover', 'dispatch-reason-hover'],
		}, true);
		if (!widget) {
			finish(undefined);
			return;
		}
		// gone some other way (a click elsewhere): the pick is dropped
		const shown = widget;
		const watch = mainWindow.setInterval(() => {
			if (shown.isDisposed || !card.isConnected) {
				finish(undefined);
			}
		}, 150);
		store.add(toDisposable(() => mainWindow.clearInterval(watch)));
		mainWindow.setTimeout(() => input.focus(), 0);
	});
}

/**
 * The card of one waiting item where a line only has room for part of it (the Projects page's line at the
 * right, a project's Now): its row (kind, title, how long it waits; a click opens it), the whole line, and
 * the buttons that answer it right there.
 */
export function renderWaitingItemCard(item: IDispatchWaitingItem, text: string, answer: (a: DispatchWaitingAnswer) => void, open: () => void, store: DisposableStore): HTMLElement {
	const card = DOM.$('.dispatch-hover-card.dispatch-waiting-item-hover');
	renderHoverRow(card, { id: item.id, icon: waitingIcon(item), title: waitingTitle(item), detail: waitingFor(item.stopped_at ?? item.at), onClick: open }, store);
	DOM.append(card, DOM.$('.dispatch-hover-text', undefined, text));
	renderWaitingHoverActions(card, item, answer, store);
	return card;
}

// ---- the item the pointer is on, in the sidebar's hover card or on the page -----------------------

/**
 * Where the pointer is: a card's row or a hover detail (`card`), the session's own row in the sidebar (`row`), the
 * thing's row under Waiting for you (`sidebar`) or the page (`page`); the others show the same item (DESIGN.md 联动悬停).
 */
export interface IDispatchWaitingHover {
	readonly id: string;
	readonly from: 'card' | 'row' | 'sidebar' | 'page';
}

export const dispatchWaitingHover = observableValue<IDispatchWaitingHover | undefined>('dispatchWaitingHover', undefined);

let hoverLeave: number | undefined;

export function enterWaitingHover(id: string, from: IDispatchWaitingHover['from']): void {
	if (hoverLeave !== undefined) {
		mainWindow.clearTimeout(hoverLeave);
		hoverLeave = undefined;
	}
	const now = dispatchWaitingHover.get();
	if (now?.id !== id || now.from !== from) {
		dispatchWaitingHover.set({ id, from }, undefined);
	}
}

/** The pointer left: cleared a moment later, so moving to the next row does not blink through "nothing". */
export function leaveWaitingHover(id: string): void {
	if (hoverLeave !== undefined) {
		mainWindow.clearTimeout(hoverLeave);
	}
	hoverLeave = mainWindow.setTimeout(() => {
		hoverLeave = undefined;
		if (dispatchWaitingHover.get()?.id === id) {
			dispatchWaitingHover.set(undefined, undefined);
		}
	}, 120);
}

/** The last line of a hover card: grey 12px, "and 3 to read · 68 only you can do". */
export function renderHoverFoot(parent: HTMLElement, text: string): HTMLElement {
	return DOM.append(parent, DOM.$('.dispatch-hover-foot', undefined, text));
}

// ---- the page's memory and the queue it hands to the session view ---------------------------------

/** Where the page was when the person went into a session from it (the view is rebuilt on the way back). */
export interface IDispatchWaitingPageMemory {
	scrollTop: number;
	focusId?: string;
	/** Where that row stood: when it is gone on the way back (read, answered), the row now in its place. */
	focusIndex?: number;
	/** Older is open (it starts closed; "N older" in the side bar opens the page with it open). */
	olderOpen: boolean;
}
export const dispatchWaitingPageMemory: IDispatchWaitingPageMemory = { scrollTop: 0, olderOpen: false };

/** A fresh open: nothing to come back to. */
export function resetDispatchWaitingPageMemory(): void {
	dispatchWaitingPageMemory.scrollTop = 0;
	dispatchWaitingPageMemory.focusId = undefined;
	dispatchWaitingPageMemory.focusIndex = undefined;
	dispatchWaitingPageMemory.olderOpen = false;
}

/** A session opened from the page: its row, so the queue bar can say "2 of 6" and step to the next. */
export interface IDispatchWaitingQueue {
	/** The row that was opened (`ide:…` or `task:…`). */
	readonly current: string;
	/** Its session's resource (the queue bar shows only over that session). */
	readonly resource?: string;
	/** The queue's order when it was opened: a handled row keeps its place for Prev / Next. */
	readonly order: readonly string[];
}
export const dispatchWaitingQueue = observableValue<IDispatchWaitingQueue | undefined>('dispatchWaitingQueue', undefined);

/** The rows the queue bar walks through: every session that waits, in the page's order. */
export function waitingQueueItems(value: IDispatchWaitingData | undefined): IDispatchWaitingItem[] {
	return (value?.items ?? []).filter(i => i.source === 'ide' && i.kind !== 'only_you' && !!i.resource);
}
