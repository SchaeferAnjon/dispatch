/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: another Mac's waiting and this Mac's name in the sessions list (kanban design/machines/redesign
 *  §4 and §5). While something waits on another Mac a row for it sits under Waiting for you (sessionsList.ts asks
 *  views/dispatchWaitingSidebar.ts for the rows, which asks this file for these); a click opens that Mac's window on
 *  its Waiting for you. After "Sessions" the machine's name, while there are two Macs or more.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchPeerWaiting.css';
import './dispatchMachinesPage.js';
import * as DOM from '../../../../base/browser/dom.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { attentionSummary, clockTime, DISPATCH_MACHINES_OPEN, dispatchMachines, IDispatchMachine, thisWindowMachine, waitingCount } from '../../../../workbench/contrib/dispatchMachines/browser/dispatchMachines.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';

// ---- another Mac's waiting (kanban design/machines/redesign §5) ------------------------------------------

const PEER_ROW_PREFIX = 'dispatch-peer:';

/** Whether a row of the sessions list is another Mac's waiting. */
export function isPeerWaitingRow(id: string): boolean {
	return id.startsWith(PEER_ROW_PREFIX);
}

/** Another Mac's rows at `at` in the list's top-level `children`; how many. */
export function insertPeerWaitingRows<T extends { element: unknown }>(children: T[], at: number): number {
	const rows = peerRows();
	children.splice(at, 0, ...(rows as unknown as T[]));
	return rows.length;
}

/** A click on another Mac's row: that Mac's window on its Waiting for you, while it is online. */
export function openPeerWaitingRow(accessor: ServicesAccessor, id: string): void {
	const peer = peerOf(id.slice(PEER_ROW_PREFIX.length));
	if (peer?.online) {
		void accessor.get(ICommandService).executeCommand(DISPATCH_MACHINES_OPEN, peer.id, { land: 'waiting' });
	}
}

export function renderPeerWaitingRow(template: ISectionTemplateLike, id: string, instantiationService: IInstantiationService): void {
	renderPeerRow(template, id.slice(PEER_ROW_PREFIX.length), instantiationService);
}

/** What each peer's row last showed while it was online: kept when it goes offline ("as of"). */
const lastSeenWaiting = new Map<string, { n: number; at: number }>();

function peerOf(id: string): IDispatchMachine | undefined {
	return dispatchMachines.get()?.find(m => m.id === id && !m.local);
}

/** Another Mac's row while something waits there (or waited when it went offline). */
function peerRows(): { element: { id: string; label: string; sessions: never[] }; children: never[]; collapsible: false }[] {
	const rows: { element: { id: string; label: string; sessions: never[] }; children: never[]; collapsible: false }[] = [];
	for (const m of dispatchMachines.get() ?? []) {
		if (m.local) {
			continue;
		}
		const n = waitingCount(m.attention);
		// online: the count now; offline: what the CLI last read there (its cache, with the time), else what
		// this window last saw
		if (n) {
			lastSeenWaiting.set(m.id, { n, at: m.attention?.as_of ?? Date.now() / 1000 });
		} else if (m.online) {
			lastSeenWaiting.delete(m.id);
		}
		if ((m.online && n) || (!m.online && lastSeenWaiting.has(m.id))) {
			rows.push({ element: { id: PEER_ROW_PREFIX + m.id, label: m.name, sessions: [] }, children: [], collapsible: false });
		}
	}
	return rows;
}

/** The list redraws its rows when a peer's waiting count or state changes, until the returned watch ends. */
export function watchPeerRows(owner: { update(): void }): IDisposable {
	let shown: string | undefined;
	return autorun(reader => {
		const list = dispatchMachines.read(reader) ?? [];
		const key = list.filter(m => !m.local).map(m => `${m.id}:${m.online}:${waitingCount(m.attention)}`).join('|');
		if (shown !== undefined && key !== shown) {
			shown = key;
			owner.update();
		}
		shown = key;
	});
}

function renderPeerRow(template: ISectionTemplateLike, id: string, instantiationService: IInstantiationService): void {
	const { container, icon, label, count, newBadge, chevron, elementDisposables } = template;
	const cls = ['session-section-shortcut', 'dispatch-waiting-peer'];
	container.classList.remove('dispatch-waiting-section', 'dispatch-projects-section');
	count.classList.remove('dispatch-waiting-count');
	container.classList.add(...cls);
	elementDisposables.add(toDisposable(() => container.classList.remove(...cls, 'offline', 'active')));
	newBadge.style.display = 'none';
	template.collapsed.set(false, undefined);
	chevron.className = 'session-section-chevron';
	icon.style.display = 'none';
	elementDisposables.add(toDisposable(() => icon.style.display = ''));
	count.style.display = 'none';
	DOM.clearNode(label);
	const tag = DOM.append(label, DOM.$('span.dispatch-machine-tag'));
	DOM.append(tag, DOM.$(`span.dispatch-machine-tag-icon${ThemeIcon.asCSSSelector(Codicon.vm)}`));
	const tagName = DOM.append(tag, DOM.$('span'));
	const dot = DOM.append(label, DOM.$('span.dispatch-waiting-peer-dot'));
	const text = DOM.append(label, DOM.$('span.dispatch-waiting-peer-text'));
	const open = DOM.append(label, DOM.$(`span.dispatch-waiting-peer-open${ThemeIcon.asCSSSelector(Codicon.linkExternal)}`));
	elementDisposables.add(toDisposable(() => DOM.clearNode(label)));
	let hoverText = '';
	elementDisposables.add(autorun(reader => {
		const m = dispatchMachines.read(reader)?.find(x => x.id === id);
		const seen = lastSeenWaiting.get(id);
		const online = !!m?.online;
		container.classList.toggle('offline', !online);
		tagName.textContent = m?.name ?? id;
		const n = online ? waitingCount(m?.attention) : seen?.n ?? 0;
		dot.style.display = online ? '' : 'none';
		open.style.display = online ? '' : 'none';
		text.textContent = online
			? localize('dispatchMachines.peerWaiting', "{0} waiting", n)
			: localize('dispatchMachines.peerOffline', "offline · {0} waiting", n);
		hoverText = online
			? localize('dispatchMachines.peerHover', "Open the {0} window · {1}", m?.name ?? id, attentionSummary(m?.attention))
			: localize('dispatchMachines.peerHoverOffline', "{0} is offline · {1} waiting as of {2}", m?.name ?? id, n, clockTime(seen?.at));
	}));
	instantiationService.invokeFunction(accessor => {
		const hoverService = accessor.get(IHoverService);
		elementDisposables.add(hoverService.setupDelayedHover(container, () => ({ content: hoverText, appearance: { showPointer: true }, position: { hoverPosition: HoverPosition.BELOW } })));
	});
}

// ---- this machine's name after "Sessions" (kanban design/machines/redesign §4) -------------------------

/**
 * The machine's name after the Sessions title, only while there are two machines or more: this Mac's
 * window in grey with a vm icon, a window on another Mac as a filled tag.
 */
export function renderSessionsMachineLabel(parent: HTMLElement, instantiationService: IInstantiationService, disposables: DisposableStore): void {
	const tag = DOM.append(parent, DOM.$('span.dispatch-sessions-machine'));
	DOM.append(tag, DOM.$(`span.dispatch-machine-tag-icon${ThemeIcon.asCSSSelector(Codicon.vm)}`));
	const name = DOM.append(tag, DOM.$('span'));
	const remote = instantiationService.invokeFunction(accessor => !!accessor.get(IWorkbenchEnvironmentService).remoteAuthority);
	tag.classList.toggle('dispatch-machine-tag', remote);
	disposables.add(autorun(reader => {
		const list = dispatchMachines.read(reader);
		const mine = thisWindowMachine(list);
		const show = (list?.length ?? 0) > 1 && !!mine;
		tag.style.display = show ? '' : 'none';
		name.textContent = mine?.name ?? '';
	}));
	disposables.add(toDisposable(() => tag.remove()));
}

/** The part of the list's section template the sidebar's own rows draw into. */
export interface ISectionTemplateLike {
	readonly container: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly count: HTMLElement;
	readonly newBadge: HTMLElement;
	readonly chevron: HTMLElement;
	readonly toolbarContainer?: HTMLElement;
	readonly collapsed: { set(value: boolean, tx: undefined): void };
	readonly elementDisposables: DisposableStore;
}
