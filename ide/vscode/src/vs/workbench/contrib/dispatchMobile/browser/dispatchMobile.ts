/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchMobile.css';

import * as DOM from '../../../../base/browser/dom.js';
import { BaseActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IAction } from '../../../../base/common/actions.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IsAuxiliaryWindowContext, IsSessionsWindowContext } from '../../../common/contextkeys.js';

// Dispatch IDE: the phone button in the title bar and its pairing popover (kanban task-0ol). The bridge's
// `dispatch.mobile` command (app/ide-ext/src/mobile.ts) runs `dispatch mobile` and `dispatch chatd`.

export const DISPATCH_MOBILE_BUTTON = 'dispatch.mobile.button';
const POLL_MS = 2000;
const ASK_MS = 45_000;

interface IPhone { readonly id: string; readonly name: string; readonly pairedAt: number; readonly lastSeen: number }
interface IMobileProblem { readonly reason: string; readonly message: string; readonly fix: string; readonly port: number }
interface IMobileState {
	readonly running: boolean;
	readonly access?: 'on' | 'off';
	readonly problem?: IMobileProblem;
	readonly chatd: boolean;
	readonly name: string;
	readonly phones: readonly IPhone[];
	readonly pair?: { readonly id: string; readonly status: string; readonly name: string };
}
interface IMobilePair {
	readonly ok?: boolean;
	readonly state?: IMobileState;
	readonly pair: string;
	readonly code: string;
	readonly expires_in: number;
	readonly svg_text?: string;
	readonly service?: string;
}

// ---- the button ---------------------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({ id: DISPATCH_MOBILE_BUTTON, title: localize2('dispatchMobile.title', "Pair iPhone"), icon: Codicon.deviceMobile, f1: false });
	}
	run(): void { mainWindow.document.querySelector<HTMLElement>('.dispatch-mobile-button-label')?.click(); }
});

// the Agents window: right after the Macs, before the bell (kanban design/bars: your devices side by side, the
// phone last); the editor window: left of the machine button
MenuRegistry.appendMenuItem(MenuId.for('SessionsTitleBarSessionMenu'), {
	command: { id: DISPATCH_MOBILE_BUTTON, title: localize('dispatchMobile.title', "Pair iPhone"), icon: Codicon.deviceMobile },
	group: 'navigation',
	order: -110,
	when: ContextKeyExpr.and(IsSessionsWindowContext, IsAuxiliaryWindowContext.toNegated()),
});
MenuRegistry.appendMenuItem(MenuId.TitleBar, {
	command: { id: DISPATCH_MOBILE_BUTTON, title: localize('dispatchMobile.title', "Pair iPhone"), icon: Codicon.deviceMobile },
	group: 'navigation',
	order: 999,
	when: ContextKeyExpr.and(IsSessionsWindowContext.toNegated(), IsAuxiliaryWindowContext.toNegated()),
});

class DispatchMobileButton extends BaseActionViewItem {

	private readonly panel = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		action: IAction,
		@IHoverService private readonly hoverService: IHoverService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(undefined, action);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('dispatch-mobile-button');
		const button = DOM.append(container, DOM.$('a.action-label.dispatch-mobile-button-label'));
		button.setAttribute('role', 'button');
		button.tabIndex = 0;
		const title = localize('dispatchMobile.hover', "Pair iPhone");
		button.setAttribute('aria-label', title);
		button.title = title;
		DOM.append(button, DOM.$(`span.dispatch-mobile-button-icon${ThemeIcon.asCSSSelector(Codicon.deviceMobile)}`));
		this._register(DOM.addDisposableListener(button, DOM.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter' || e.key === ' ') {
				DOM.EventHelper.stop(e, true);
				this.toggle(button);
			}
		}));
	}

	override onClick(event: MouseEvent): void {
		DOM.EventHelper.stop(event, true);
		const anchor = this.element?.querySelector<HTMLElement>('.dispatch-mobile-button-label');
		if (anchor) {
			this.toggle(anchor);
		}
	}

	private toggle(anchor: HTMLElement): void {
		if (this.panel.value) {
			this.panel.clear();
			this.hoverService.hideHover(true);
			return;
		}
		// another hover still up would keep this one from showing, as with the machine button next to it
		this.hoverService.hideHover(true);
		const store = new DisposableStore();
		this.panel.value = store;
		anchor.classList.add('open');
		store.add(toDisposable(() => anchor.classList.remove('open')));
		const content = this.instantiationService.createInstance(PairingPanel).render(store);
		const hover = this.hoverService.showInstantHover({
			content,
			target: anchor,
			additionalClasses: ['dispatch-mobile-panel-hover'],
			position: { hoverPosition: HoverPosition.BELOW },
			persistence: { sticky: true, hideOnHover: false },
			appearance: { showPointer: false, skipFadeInAnimation: true, maxHeightRatio: 0.9 },
		}, true);
		if (!hover) {
			this.panel.clear();
			return;
		}
		store.add(hover);
		store.add(DOM.addDisposableListener(mainWindow.document, DOM.EventType.KEY_DOWN, e => {
			if (e.key === 'Escape') {
				this.panel.clear();
				this.hoverService.hideHover(true);
			}
		}, true));
		// closed from outside (a click elsewhere): stop polling
		const timer = mainWindow.setInterval(() => {
			if (!content.isConnected || hover.isDisposed) {
				this.panel.clear();
			}
		}, 400);
		store.add(toDisposable(() => mainWindow.clearInterval(timer)));
	}
}

class DispatchMobileContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.dispatchMobile';
	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		for (const menu of [MenuId.for('SessionsTitleBarSessionMenu'), MenuId.TitleBar]) {
			this._register(actionViewItemService.register(menu, DISPATCH_MOBILE_BUTTON, action => instantiationService.createInstance(DispatchMobileButton, action)));
		}
	}
}
// before the title bar draws itself (as Machines): registered later, a reloaded window kept the plain icon
registerWorkbenchContribution2(DispatchMobileContribution.ID, DispatchMobileContribution, WorkbenchPhase.BlockRestore);

// ---- the popover --------------------------------------------------------------------------------------

type View =
	| { readonly kind: 'loading' }
	| { readonly kind: 'down'; readonly busy: boolean; readonly error?: string; readonly problem?: IMobileProblem }
	| { readonly kind: 'code'; readonly pair: string; readonly code: string; readonly svg: string; readonly expiresAt: number }
	| { readonly kind: 'paired'; readonly name: string }
	| { readonly kind: 'error'; readonly message: string };

/** The QR code from the CLI's SVG, built node by node (the page does not take markup strings). */
function qrElement(svgText: string): SVGElement | undefined {
	const box = /viewBox="0 0 (\d+) (\d+)"/.exec(svgText);
	const path = /<path d="([^"]*)"/.exec(svgText);
	if (!box || !path) {
		return undefined;
	}
	const NS = 'http://www.w3.org/2000/svg';
	const doc = mainWindow.document;
	const svg = doc.createElementNS(NS, 'svg');
	svg.setAttribute('viewBox', `0 0 ${box[1]} ${box[2]}`);
	svg.setAttribute('shape-rendering', 'crispEdges');
	svg.setAttribute('role', 'img');
	svg.setAttribute('aria-label', localize('dispatchMobile.qrLabel', "Pairing code for Dispatch on your iPhone"));
	const bg = doc.createElementNS(NS, 'rect');
	bg.setAttribute('width', box[1]);
	bg.setAttribute('height', box[2]);
	bg.setAttribute('fill', '#ffffff');
	svg.appendChild(bg);
	const modules = doc.createElementNS(NS, 'path');
	modules.setAttribute('d', path[1]);
	modules.setAttribute('fill', '#000000');
	svg.appendChild(modules);
	return svg;
}

function clock(seconds: number): string {
	const s = Math.max(0, Math.ceil(seconds));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function spaced(code: string): string {
	return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

class PairingPanel {

	private readonly store = new DisposableStore();
	private view: View = { kind: 'loading' };
	private phones: readonly IPhone[] = [];
	private phonesKnown = false;
	private pairHost!: HTMLElement;
	private phonesHost!: HTMLElement;
	private countdown: HTMLElement | undefined;
	private tile: HTMLElement | undefined;
	private newCodeButton: HTMLElement | undefined;
	private polling = false;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
	) { }

	render(store: DisposableStore): HTMLElement {
		store.add(this.store);
		const panel = DOM.$('.dispatch-mobile-panel');
		const head = DOM.append(panel, DOM.$('.dispatch-mobile-head'));
		DOM.append(head, DOM.$(`span.dispatch-mobile-head-icon${ThemeIcon.asCSSSelector(Codicon.deviceMobile)}`));
		DOM.append(head, DOM.$('span.dispatch-mobile-title', undefined, localize('dispatchMobile.panelTitle', "Pair your iPhone")));
		this.pairHost = DOM.append(panel, DOM.$('.dispatch-mobile-pair'));
		this.phonesHost = DOM.append(panel, DOM.$('.dispatch-mobile-phones'));
		this.show({ kind: 'loading' });
		const tick = mainWindow.setInterval(() => this.tick(), 500);
		this.store.add(toDisposable(() => mainWindow.clearInterval(tick)));
		const poll = mainWindow.setInterval(() => void this.poll(), POLL_MS);
		this.store.add(toDisposable(() => mainWindow.clearInterval(poll)));
		void this.start();
		return panel;
	}

	private get closed(): boolean {
		return this.store.isDisposed;
	}

	private async ask<T>(op: string, ...args: unknown[]): Promise<T | undefined> {
		return raceTimeout(this.commandService.executeCommand<T>('dispatch.mobile', op, ...args), ASK_MS);
	}

	private async start(): Promise<void> {
		try {
			const state = await this.ask<IMobileState>('state');
			if (this.closed) {
				return;
			}
			if (!state) {
				this.show({ kind: 'error', message: localize('dispatchMobile.noAnswer', "Dispatch is not answering. Try again in a moment.") });
				return;
			}
			this.setPhones(state.phones);
			// phone access is off until you pair (kanban task-lj06.19): opening this to pair turns it on, so only a
			// Mac without Dispatch's background service starts on the button that brings it up
			if (!state.running && !state.chatd) {
				this.show({ kind: 'down', busy: false });
				return;
			}
			await this.newCode();
		} catch (e) {
			this.fail(e);
		}
	}

	private fail(e: unknown): void {
		if (this.closed) {
			return;
		}
		const text = String((e as Error)?.message ?? e);
		this.show({ kind: 'error', message: /not found|bad request/.test(text) ? localize('dispatchMobile.oldBridge', "This version of Dispatch cannot pair phones yet. Update Dispatch and try again.") : localize('dispatchMobile.wrong', "Something went wrong. Try again in a moment.") });
	}

	/** A fresh code; the one on screen (when nobody used it) is dropped on the Mac. */
	private async newCode(): Promise<void> {
		const old = this.view.kind === 'code' ? this.view.pair : undefined;
		this.show({ kind: 'loading' });
		try {
			const r = await this.ask<IMobilePair>('pair', old);
			if (this.closed) {
				return;
			}
			// the service did not start (the port is taken, …): say why, and no code that cannot connect
			if (r?.ok === false) {
				this.show({ kind: 'down', busy: false, problem: r.state?.problem });
				return;
			}
			if (!r?.code || !r.svg_text) {
				this.show({ kind: 'error', message: localize('dispatchMobile.noCode', "Could not make a pairing code. Try again in a moment.") });
				return;
			}
			if (r.service === 'not_running') {
				this.show({ kind: 'down', busy: false });
				return;
			}
			this.show({ kind: 'code', pair: r.pair, code: r.code, svg: r.svg_text, expiresAt: Date.now() + r.expires_in * 1000 });
		} catch (e) {
			this.fail(e);
		}
	}

	/** Turns phone access on (`on`), or first lets it take another port (`another-port`), then makes a code. */
	private async install(op: 'on' | 'another-port' = 'on'): Promise<void> {
		this.show({ kind: 'down', busy: true });
		try {
			const r = await this.ask<{ ok: boolean; state?: IMobileState }>(op);
			if (this.closed) {
				return;
			}
			if (r?.ok) {
				await this.newCode();
			} else if (r?.state?.problem) {
				this.show({ kind: 'down', busy: false, problem: r.state.problem });
			} else {
				this.show({ kind: 'down', busy: false, error: localize('dispatchMobile.installFailed', "Could not turn it on. Restart Dispatch and try again.") });
			}
		} catch (e) {
			this.show({ kind: 'down', busy: false, error: localize('dispatchMobile.installFailed2', "Could not turn it on. Restart Dispatch and try again.") });
		}
	}

	private async poll(): Promise<void> {
		if (this.polling || this.closed || this.view.kind === 'loading' || (this.view.kind === 'down' && this.view.busy)) {
			return;
		}
		this.polling = true;
		try {
			const pair = this.view.kind === 'code' ? this.view.pair : undefined;
			const state = await this.ask<IMobileState>('state', pair);
			if (this.closed || !state) {
				return;
			}
			this.setPhones(state.phones);
			const view = this.view;
			if (view.kind === 'code' && state.pair?.status === 'paired') {
				this.show({ kind: 'paired', name: state.pair.name });
			} else if (view.kind === 'code' && !state.running) {
				// the service went away while the code was up: the code cannot connect any more
				this.show({ kind: 'down', busy: false, problem: state.problem });
			}
		} catch {
			// the next poll tries again
		} finally {
			this.polling = false;
		}
	}

	private tick(): void {
		const view = this.view;
		if (view.kind !== 'code' || !this.countdown) {
			return;
		}
		const left = (view.expiresAt - Date.now()) / 1000;
		const expired = left <= 0;
		this.countdown.textContent = expired ? localize('dispatchMobile.expired', "Code expired") : localize('dispatchMobile.expiresIn', "Expires in {0}", clock(left));
		this.tile?.classList.toggle('expired', expired);
		this.newCodeButton?.classList.toggle('prominent', expired);
	}

	// ---- drawing

	private show(view: View): void {
		this.view = view;
		this.countdown = undefined;
		this.tile = undefined;
		this.newCodeButton = undefined;
		DOM.clearNode(this.pairHost);
		const host = this.pairHost;
		switch (view.kind) {
			case 'loading': {
				host.appendChild(this.how());
				const tile = DOM.append(host, DOM.$('.dispatch-mobile-tile.loading'));
				DOM.append(tile, DOM.$(`span${ThemeIcon.asCSSSelector(ThemeIcon.modify(Codicon.loading, 'spin'))}`));
				break;
			}
			case 'down':
				this.drawDown(host, view);
				break;
			case 'code':
				this.drawCode(host, view);
				break;
			case 'paired': {
				const done = DOM.append(host, DOM.$('.dispatch-mobile-done'));
				DOM.append(done, DOM.$(`span.dispatch-mobile-done-icon${ThemeIcon.asCSSSelector(Codicon.check)}`));
				DOM.append(done, DOM.$('.dispatch-mobile-done-title', undefined, localize('dispatchMobile.paired', "Paired")));
				DOM.append(done, DOM.$('.dispatch-mobile-note', undefined, localize('dispatchMobile.pairedWith', "{0} is connected to this Mac.", view.name)));
				const again = this.pill(done, Codicon.add, localize('dispatchMobile.another', "Pair another phone"));
				this.store.add(DOM.addDisposableListener(again, DOM.EventType.CLICK, () => void this.newCode()));
				break;
			}
			case 'error': {
				const note = DOM.append(host, DOM.$('.dispatch-mobile-down'));
				DOM.append(note, DOM.$('.dispatch-mobile-note', undefined, view.message));
				const retry = this.pill(note, Codicon.refresh, localize('dispatchMobile.tryAgain', "Try again"));
				this.store.add(DOM.addDisposableListener(retry, DOM.EventType.CLICK, () => { this.show({ kind: 'loading' }); void this.start(); }));
				break;
			}
		}
	}

	private drawDown(host: HTMLElement, view: { readonly busy: boolean; readonly error?: string; readonly problem?: IMobileProblem }): void {
		const down = DOM.append(host, DOM.$('.dispatch-mobile-down'));
		DOM.append(down, DOM.$(`span.dispatch-mobile-down-icon${ThemeIcon.asCSSSelector(Codicon.debugDisconnect)}`));
		const problem = view.problem;
		if (problem && problem.reason !== 'no_background') {
			// on, but the phone cannot reach this Mac: what happened, what to do, and no code (kanban task-lj06.19)
			down.dataset.problem = problem.reason;
			DOM.append(down, DOM.$('.dispatch-mobile-done-title', undefined, localize('dispatchMobile.notWorking', "Phone access is not working")));
			DOM.append(down, DOM.$('.dispatch-mobile-note', undefined, problem.message));
			if (problem.fix) {
				DOM.append(down, DOM.$('.dispatch-mobile-note', undefined, problem.fix));
			}
			const again = this.pill(down, view.busy ? ThemeIcon.modify(Codicon.loading, 'spin') : Codicon.refresh, view.busy ? localize('dispatchMobile.starting', "Turning on...") : localize('dispatchMobile.tryAgain', "Try again"));
			if (view.busy) {
				again.setAttribute('disabled', 'true');
			}
			this.store.add(DOM.addDisposableListener(again, DOM.EventType.CLICK, () => void this.install('on')));
			if (problem.reason === 'port_in_use' || problem.reason === 'not_allowed') {
				const other = this.pill(down, Codicon.arrowSwap, localize('dispatchMobile.anotherPort', "Use another port"));
				other.classList.add('dispatch-mobile-another-port');
				this.store.add(DOM.addDisposableListener(other, DOM.EventType.CLICK, () => void this.install('another-port')));
			}
			return;
		}
		DOM.append(down, DOM.$('.dispatch-mobile-done-title', undefined, localize('dispatchMobile.notRunning', "Phone access is off")));
		DOM.append(down, DOM.$('.dispatch-mobile-note', undefined, localize('dispatchMobile.needService', "Turn it on so your iPhone can connect to this Mac.")));
		if (view.error) {
			DOM.append(down, DOM.$('.dispatch-mobile-note.error', undefined, view.error));
		}
		const start = this.pill(down, view.busy ? ThemeIcon.modify(Codicon.loading, 'spin') : Codicon.play, view.busy ? localize('dispatchMobile.starting', "Turning on...") : localize('dispatchMobile.start', "Turn on phone access"));
		if (view.busy) {
			start.setAttribute('disabled', 'true');
		}
		this.store.add(DOM.addDisposableListener(start, DOM.EventType.CLICK, () => void this.install('on')));
	}

	private drawCode(host: HTMLElement, view: { readonly code: string; readonly svg: string }): void {
		host.appendChild(this.how());
		host.appendChild(this.whereToGet());
		const tile = this.tile = DOM.append(host, DOM.$('.dispatch-mobile-tile'));
		const qr = qrElement(view.svg);
		if (qr) {
			tile.appendChild(qr);
		}
		DOM.append(host, DOM.$('.dispatch-mobile-code', { 'aria-label': localize('dispatchMobile.codeLabel', "Pairing code {0}", view.code.split('').join(' ')) }, spaced(view.code)));
		DOM.append(host, DOM.$('.dispatch-mobile-note', undefined, localize('dispatchMobile.typeIt', "Can't scan? Enter this code on your iPhone.")));
		const line = DOM.append(host, DOM.$('.dispatch-mobile-expiry'));
		this.countdown = DOM.append(line, DOM.$('span.dispatch-mobile-countdown'));
		const fresh = this.newCodeButton = this.pill(line, Codicon.refresh, localize('dispatchMobile.newCode', "New code"));
		this.store.add(DOM.addDisposableListener(fresh, DOM.EventType.CLICK, () => void this.newCode()));
		this.tick();
	}

	private how(): HTMLElement {
		return DOM.$('.dispatch-mobile-how', undefined, localize('dispatchMobile.how', "Open Dispatch on your iPhone, tap Scan, and point the camera at this code."));
	}

	/** Where the iPhone app comes from: it is not in the App Store yet, and the page says so instead of a link (kanban task-lj06.36). */
	private whereToGet(): HTMLElement {
		return DOM.$('.dispatch-mobile-note.dispatch-mobile-get', undefined, localize('dispatchMobile.getApp', "No Dispatch app on your iPhone? It is not in the App Store yet. It is coming soon."));
	}

	private pill(parent: HTMLElement, icon: ThemeIcon, label: string): HTMLElement {
		const b = DOM.append(parent, DOM.$('button.dispatch-mobile-pill'));
		DOM.append(b, DOM.$(`span${ThemeIcon.asCSSSelector(icon)}`));
		DOM.append(b, DOM.$('span', undefined, label));
		return b;
	}

	private setPhones(phones: readonly IPhone[]): void {
		const same = this.phonesKnown && phones.length === this.phones.length && phones.every((p, i) => p.id === this.phones[i].id && p.name === this.phones[i].name);
		this.phones = phones;
		this.phonesKnown = true;
		if (same) {
			return;
		}
		DOM.clearNode(this.phonesHost);
		const label = DOM.append(this.phonesHost, DOM.$('.dispatch-mobile-section-head', undefined, localize('dispatchMobile.pairedPhones', "Paired phones")));
		label.classList.toggle('empty', phones.length === 0);
		if (!phones.length) {
			DOM.append(this.phonesHost, DOM.$('.dispatch-mobile-row-empty', undefined, localize('dispatchMobile.none', "No phone is paired yet.")));
			return;
		}
		for (const phone of phones) {
			const row = DOM.append(this.phonesHost, DOM.$('.dispatch-mobile-row'));
			DOM.append(row, DOM.$(`span.dispatch-mobile-row-icon${ThemeIcon.asCSSSelector(Codicon.deviceMobile)}`));
			DOM.append(row, DOM.$('span.dispatch-mobile-row-name', undefined, phone.name));
			if (phone.pairedAt) {
				const date = new Date(phone.pairedAt * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
				DOM.append(row, DOM.$('span.dispatch-mobile-row-time', undefined, localize('dispatchMobile.pairedOn', "Paired {0}", date)));
			}
			const remove = DOM.append(row, DOM.$('button.dispatch-mobile-remove', { 'aria-label': localize('dispatchMobile.removeLabel', "Remove {0}", phone.name) }, localize('dispatchMobile.remove', "Remove")));
			this.store.add(DOM.addDisposableListener(remove, DOM.EventType.CLICK, () => void this.remove(phone)));
		}
	}

	private async remove(phone: IPhone): Promise<void> {
		// gone from the list at once; the Mac forgets it a moment later
		this.setPhones(this.phones.filter(p => p.id !== phone.id));
		try {
			await this.ask('revoke', phone.id);
			const state = await this.ask<IMobileState>('state', this.view.kind === 'code' ? this.view.pair : undefined);
			if (!this.closed && state) {
				this.setPhones(state.phones);
			}
		} catch {
			// the row stays; the next poll shows what is left
		}
	}
}
