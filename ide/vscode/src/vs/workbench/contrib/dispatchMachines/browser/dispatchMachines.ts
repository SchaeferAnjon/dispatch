/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchMachines.css';
import { IDispatchAttention, IDispatchRecent, IDispatchMachine, machinesValue, dispatchMachines, connectionState, thisWindowMachine, rememberedName, rememberMachineNames, setMachineStorage } from '../../../services/remote/browser/dispatchMachineIdentity.js';
export type { IDispatchAttention, IDispatchRecent, IDispatchMachine } from '../../../services/remote/browser/dispatchMachineIdentity.js';
export { dispatchMachines, connectionState, thisWindowMachine, rememberedName } from '../../../services/remote/browser/dispatchMachineIdentity.js';

import * as DOM from '../../../../base/browser/dom.js';
import { BaseActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { IAction } from '../../../../base/common/actions.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableValue } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { setupDispatchTextHover } from '../../../browser/dispatchHoverCard.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { PersistentConnectionEventType } from '../../../../platform/remote/common/remoteAgentConnection.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { MachinePreparation, MACHINE_NAMES_KEY, preparationKey, parsePreparation } from '../../../services/remote/common/dispatchMachineState.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IsAuxiliaryWindowContext, IsSessionsWindowContext } from '../../../common/contextkeys.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';
import { ensureDispatchPalette } from '../../../../base/browser/dispatchPalette.js';

// the dots and the frame are the app icon's state colours (--dispatch-state-*, base/common/dispatchPalette.ts)
ensureDispatchPalette();

export const DISPATCH_MACHINES_BUTTON = 'dispatch.machines.button';
export const DISPATCH_MACHINES_OPEN = 'dispatch.machines.open';
export const DISPATCH_MACHINES_ADD = 'dispatch.machines.add';
export const DISPATCH_MACHINES_MANAGE = 'dispatch.machines.manage';
const POLL_MS = 60_000;

// ---- the data ---------------------------------------------------------------------------------------

let machinesError = '';
/** The last ask failed (no answer yet): the button stops spinning and asks again soon. */
const machinesFailed = observableValue<boolean>('dispatchMachinesFailed', false);
let running: Promise<void> | undefined;

let lastAnswerAt = 0;

// What the last answers said, for the moments without one: a window on another Mac shows that Mac's name while
// it connects (this app's windows share localStorage, the window on this Mac wrote it), and an offline Mac keeps
// its last three projects, greyed out.
const lastRecent = new Map<string, readonly IDispatchRecent[]>();
function rememberMachines(list: readonly IDispatchMachine[]): void {
	for (const m of list) {
		if (m.recent?.length) {
			lastRecent.set(m.id, m.recent);
		}
	}
	rememberMachineNames(list);
}
/** Ask for the list again. `quiet` (window focus): not when the last answer is under 15 s old. */
export function refreshDispatchMachines(commandService: ICommandService, quiet = false): Promise<void> {
	if (quiet && Date.now() - lastAnswerAt < 15_000) {
		return running ?? Promise.resolve();
	}
	running ??= (async () => {
		try {
			// a window on another Mac asks before its extension host is up: that first call can wait forever,
			// so every call gets 30 s and the next one starts clean
			let late = false;
			const res = await raceTimeout(commandService.executeCommand<IDispatchMachine[]>('dispatch.machines'), 30_000, () => late = true);
			if (Array.isArray(res)) {
				lastAnswerAt = Date.now();
				rememberMachines(res);
				machinesValue.set(res, undefined);
				machinesError = '';
				machinesFailed.set(false, undefined);
			} else if (late) {
				machinesError = 'timeout';
				machinesFailed.set(true, undefined);
			}
		} catch (e) {
			machinesError = String((e as Error)?.message ?? e);
			machinesFailed.set(true, undefined);
		} finally {
			running = undefined;
		}
	})();
	return running;
}

/**
 * The Mac this app runs on: in a window on this Mac, the local row; in a window on another Mac, the one of
 * the others that is not reached over ssh from here (with two machines, simply the other one).
 */
export function clientMachine(list: readonly IDispatchMachine[] | undefined, remote: boolean): IDispatchMachine | undefined {
	if (!list) {
		return undefined;
	}
	return remote ? list.find(m => !m.local) : list.find(m => m.local);
}

function waitingParts(a: IDispatchAttention | null | undefined): string[] {
	if (!a) {
		return [];
	}
	const parts: string[] = [];
	if (a.approve) {
		parts.push(localize('dispatchMachines.toApprove', "{0} to approve", a.approve));
	}
	if (a.decide) {
		parts.push(localize('dispatchMachines.toDecide', "{0} to decide", a.decide));
	}
	if (a.unread) {
		parts.push(localize('dispatchMachines.toRead', "{0} to read", a.unread));
	}
	return parts;
}

/** Waiting items that ask for the person now (the Only-you backlog is not counted here). */
export function waitingCount(a: IDispatchAttention | null | undefined): number {
	return a ? (a.approve ?? 0) + (a.decide ?? 0) + (a.unread ?? 0) : 0;
}

export function attentionSummary(a: IDispatchAttention | null | undefined): string {
	return waitingParts(a).join(', ');
}

function ago(epoch: number | undefined | null): string {
	if (!epoch) {
		return '';
	}
	const s = Math.max(0, Math.round(Date.now() / 1000 - epoch));
	if (s < 90) {
		return localize('dispatchMachines.now', "now");
	}
	if (s < 3600) {
		return localize('dispatchMachines.minutes', "{0}m", Math.round(s / 60));
	}
	if (s < 86400) {
		return localize('dispatchMachines.hours', "{0}h", Math.round(s / 3600));
	}
	return localize('dispatchMachines.days', "{0}d", Math.round(s / 86400));
}

export function clockTime(epoch: number | undefined | null): string {
	if (!epoch) {
		return '';
	}
	const d = new Date(epoch * 1000);
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---- opening a machine's window ---------------------------------------------------------------------------

/**
 * The window of that machine: this window's machine, nothing; a window already open on it, to the front;
 * this Mac, a new window here; another Mac, a new window connected to it (dispatch-bridge).
 */
export async function openMachineWindow(accessor: ServicesAccessor, id: string, options?: string | { dir?: string; land?: 'waiting' }): Promise<void> {
	const dir = typeof options === 'string' ? options : options?.dir;
	const land = typeof options === 'object' ? options.land : undefined;
	const commandService = accessor.get(ICommandService);
	const nativeHostService = accessor.get(INativeHostService);
	const environmentService = accessor.get(IWorkbenchEnvironmentService);
	const notificationService = accessor.get(INotificationService);
	let list = machinesValue.get();
	if (!list) {
		await refreshDispatchMachines(commandService);
		list = machinesValue.get();
	}
	const m = list?.find(x => x.id === id);
	if (!m) {
		notificationService.warn(localize('dispatchMachines.unknown', "Dispatch does not know a machine called {0}.", id));
		return;
	}
	const remote = !!environmentService.remoteAuthority;
	if (m.local && !dir) {
		if (land) { await commandService.executeCommand('dispatch.waiting.show'); }
		return; // this window's own
	}
	const client = clientMachine(list, remote);
	const onClient = client?.id === m.id;
	// a window already open on it comes to the front
	if (!dir) {
		const windows = await nativeHostService.getWindows({ includeAuxiliaryWindows: false });
		const current = await nativeHostService.getActiveWindowId();
		const match = windows.find(w => {
			if (w.id === current || (land && !w.isSessionsWindow)) {
				return false;
			}
			const uri = w.workspace && 'uri' in w.workspace ? URI.revive(w.workspace.uri) : w.workspace && 'configPath' in w.workspace ? URI.revive(w.workspace.configPath) : undefined;
			const authority = w.remoteAuthority ?? (uri?.scheme === 'vscode-remote' ? uri.authority : undefined);
			return onClient ? !authority : !!authority && authority === m.authority;
		});
		if (match) {
			if (land) { await commandService.executeCommand('dispatch.machines', 'land', m.id); }
			await nativeHostService.focusWindow({ targetWindowId: match.id });
			return;
		}
	}
	if (onClient) {
		if (land) { await commandService.executeCommand('dispatch.machines', 'land', m.id); }
		const folder = dir || m.recent?.[0]?.dir;
		await nativeHostService.openAgentsWindow({ folderUri: folder ? URI.file(folder) : undefined });
		return;
	}
	const answer = await commandService.executeCommand<{ ok?: boolean; message?: string }>('dispatch.machines', 'openWindow', m.id, { dir, land });
	if (answer && answer.ok === false) {
		notificationService.warn(answer.message || localize('dispatchMachines.openFailed', "Could not open {0}.", m.name));
	}
}

CommandsRegistry.registerCommand(DISPATCH_MACHINES_OPEN, (accessor, id: string, options?: string | { dir?: string; land?: 'waiting' }) => openMachineWindow(accessor, id, options));

CommandsRegistry.registerCommand('dispatch.machines.openRemoteWindow', async (accessor, folder: URI) => {
 const uri = URI.revive(folder);
 if (uri.scheme !== 'vscode-remote') { throw new Error('A remote folder is required'); }
 // A peer always opens in Agents mode. Cmd+E keeps the same remote folder in the editor.
 await accessor.get(INativeHostService).openAgentsWindow({ folderUri: uri });
});
CommandsRegistry.registerCommand('dispatch.machines.connectionProgress', (accessor, authority: string, progress: MachinePreparation) => {
 const storage = accessor.get(IStorageService);
 const key = preparationKey(authority);
 const old = parsePreparation(storage.get(key, StorageScope.APPLICATION_SHARED));
 const next = { ...progress, owner: progress.stage === 'finding' ? mainWindow.vscodeWindowId : old?.owner ?? mainWindow.vscodeWindowId, retry: false };
 storage.store(key, JSON.stringify(next), StorageScope.APPLICATION_SHARED, StorageTarget.MACHINE);
 const names = JSON.parse(storage.get(MACHINE_NAMES_KEY, StorageScope.APPLICATION_SHARED) || '{}');
 names[authority] = progress.name;
 storage.store(MACHINE_NAMES_KEY, JSON.stringify(names), StorageScope.APPLICATION_SHARED, StorageTarget.MACHINE);
});
CommandsRegistry.registerCommand('dispatch.machines.attentionChanged', (accessor, event: { host?: string; attention?: IDispatchAttention }) => {
 if (event.attention && event.host) {
  machinesValue.set(machinesValue.get()?.map(m => m.id === event.host ? { ...m, attention: event.attention!, online: true } : m), undefined);
 }
 void refreshDispatchMachines(accessor.get(ICommandService));
});

// ---- the button -----------------------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({ id: DISPATCH_MACHINES_BUTTON, title: localize2('dispatchMachines.title', "Machines"), icon: Codicon.vm, f1: false });
	}
	run(): void { mainWindow.document.querySelector<HTMLElement>('.dispatch-machines-button-label')?.click(); }
});

// the Agents window: your devices first, then the phone and the bell (kanban design/bars)
MenuRegistry.appendMenuItem(MenuId.for('SessionsTitleBarSessionMenu'), {
	command: { id: DISPATCH_MACHINES_BUTTON, title: localize('dispatchMachines.title', "Machines"), icon: Codicon.vm },
	group: 'navigation',
	order: -120,
	when: ContextKeyExpr.and(IsSessionsWindowContext, IsAuxiliaryWindowContext.toNegated()),
});
MenuRegistry.appendMenuItem(MenuId.TitleBar, {
	command: { id: DISPATCH_MACHINES_BUTTON, title: localize('dispatchMachines.title', "Machines"), icon: Codicon.vm },
	group: 'navigation',
	order: 1000,
	when: ContextKeyExpr.and(IsSessionsWindowContext.toNegated(), IsAuxiliaryWindowContext.toNegated()),
});

/**
 * A Mac's state in the panel and on the Machines page (DESIGN.md「符号表」, task-o01fh): VS Code's filled circle, green
 * online and amber when something waits for you, the large ring offline; 14px, hidden from screen readers (the words
 * beside it say it).
 */
export function machineMark(state: 'online' | 'waiting' | 'offline'): HTMLElement {
	const el = DOM.$(`span.dispatch-machines-mark.${state}${ThemeIcon.asCSSSelector(state === 'offline' ? Codicon.circleLarge : Codicon.circleLargeFilled)}`);
	el.setAttribute('aria-hidden', 'true');
	return el;
}

class DispatchMachinesButton extends BaseActionViewItem {

	private readonly panel = this._register(new MutableDisposable<DisposableStore>());
	private icon!: HTMLElement;
	private label!: HTMLElement;
	private others!: HTMLElement;

	constructor(
		action: IAction,
		@IHoverService private readonly hoverService: IHoverService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
	) {
		super(undefined, action);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('dispatch-machines-button');
		const button = DOM.append(container, DOM.$('a.action-label.dispatch-machines-button-label'));
		button.setAttribute('role', 'button');
		button.tabIndex = 0;
		this.icon = DOM.append(button, DOM.$('span.dispatch-machines-button-icon'));
		this.label = DOM.append(button, DOM.$('span.dispatch-machines-button-name'));
		// Dispatch IDE: your devices side by side (kanban design/bars): this Mac, then each other Mac with its dot
		// (green online, amber something waits, a hollow ring offline); the phone button follows
		this.others = DOM.append(button, DOM.$('span.dispatch-machines-others'));
		const remote = !!this.environmentService.remoteAuthority;
		this._register(autorun(reader => {
			const list = dispatchMachines.read(reader);
			const state = connectionState.read(reader);
			const mine = thisWindowMachine(list);
			const many = (list?.length ?? 0) > 1;
			const failed = machinesFailed.read(reader);
			const connecting = remote && (state === 'connecting' || state === 'reconnecting' || (!list && !failed && state !== 'disconnected'));
			const name = mine?.name ?? (remote ? rememberedName(this.environmentService.remoteAuthority) : '');
			button.classList.toggle('remote', remote);
			button.classList.toggle('named', many || remote);
			button.classList.toggle('offline', remote && state === 'disconnected');
			this.icon.className = `dispatch-machines-button-icon ${ThemeIcon.asClassName(connecting ? ThemeIcon.modify(Codicon.loading, 'spin') : Codicon.vm)}`;
			this.label.textContent = many || remote ? name : '';
			DOM.clearNode(this.others);
			const others = (list ?? []).filter(m => m !== mine);
			for (const m of others) {
				const dev = DOM.append(this.others, DOM.$(`span.dispatch-machines-other${ThemeIcon.asCSSSelector(Codicon.vm)}`));
				const dot = DOM.append(dev, DOM.$('span.dispatch-machines-other-dot'));
				dot.classList.add(!m.online ? 'offline' : m.attention ? 'waiting' : 'online');
			}
			const othersText = others.map(m => !m.online
				? localize('dispatchMachines.otherOffline', "{0}: offline", m.name)
				: localize('dispatchMachines.otherOnline', "{0}: online", m.name)).join(', ');
			const title = connecting
				? localize('dispatchMachines.connectingTo', "Connecting to {0}...", name || localize('dispatchMachines.theMac', "the Mac"))
				: many ? localize('dispatchMachines.hoverDevices', "Your Macs: {0} (this one), {1}", name, othersText) : localize('dispatchMachines.hover', "Machines");
			button.setAttribute('aria-label', title);
			button.title = title;
		}));
		this._register(DOM.addDisposableListener(button, DOM.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter' || e.key === ' ') {
				DOM.EventHelper.stop(e, true);
				this.toggle(button);
			}
		}));
	}

	override onClick(event: MouseEvent): void {
		DOM.EventHelper.stop(event, true);
		const anchor = this.element?.querySelector<HTMLElement>('.dispatch-machines-button-label');
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
		// another hover still up (a tooltip, a sticky one) would keep this one from showing: close it first,
		// the way the account panel next to this button does
		this.hoverService.hideHover(true);
		const store = new DisposableStore();
		this.panel.value = store;
		// pressed while its panel is open
		anchor.classList.add('open');
		store.add(toDisposable(() => anchor.classList.remove('open')));
		void refreshDispatchMachines(this.commandService);
		const content = this.instantiationService.createInstance(MachinesPanel).render(store, () => {
			this.panel.clear();
			this.hoverService.hideHover(true);
		});
		const hover = this.hoverService.showInstantHover({
			content,
			target: anchor,
			additionalClasses: ['dispatch-machines-panel-hover'],
			position: { hoverPosition: HoverPosition.BELOW },
			persistence: { sticky: true, hideOnHover: false },
			appearance: { showPointer: false, skipFadeInAnimation: true, maxHeightRatio: 0.8 },
		}, true);
		if (!hover) {
			this.panel.clear();
			return;
		}
		store.add(hover);
		const timer = mainWindow.setInterval(() => {
			if (!content.isConnected || hover.isDisposed) {
				this.panel.clear();
			}
		}, 400);
		store.add(toDisposable(() => mainWindow.clearInterval(timer)));
	}
}

// ---- the panel --------------------------------------------------------------------------------------------

class MachinesPanel {

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IHoverService private readonly hoverService: IHoverService,
	) { }

	render(store: DisposableStore, close: () => void): HTMLElement {
		const panel = DOM.$('.dispatch-machines-panel');
		const body = DOM.append(panel, DOM.$('.dispatch-machines-panel-body'));
		const remote = !!this.environmentService.remoteAuthority;
		const run = (fn: (accessor: ServicesAccessor) => unknown) => {
			close();
			void this.instantiationService.invokeFunction(fn);
		};
		const sectionStore = store.add(new DisposableStore());
		store.add(autorun(reader => {
			const list = dispatchMachines.read(reader);
			sectionStore.clear();
			DOM.clearNode(body);
			if (!list) {
				DOM.append(body, DOM.$('.dispatch-machines-panel-note', undefined, !machinesError ? localize('dispatchMachines.looking', "Looking for your Macs...")
					: /invalid choice|unrecognized arguments/.test(machinesError) ? localize('dispatchMachines.oldCli', "Update the dispatch command to list your Macs.")
						: localize('dispatchMachines.cannot', "Could not list your Macs: {0}", machinesError.split('\n')[0])));
				return;
			}
			const mine = thisWindowMachine(list);
			const client = clientMachine(list, remote);
			const ordered = [...list].sort((a, b) => (b.local ? 1 : 0) - (a.local ? 1 : 0));
			for (const m of ordered) {
				this.renderSection(body, m, m === mine, m === client, sectionStore, run);
			}
		}));
		const footer = DOM.append(panel, DOM.$('.dispatch-machines-panel-footer'));
		const add = DOM.append(footer, DOM.$('button.dispatch-machines-panel-footer-action'));
		DOM.append(add, DOM.$(`span${ThemeIcon.asCSSSelector(Codicon.add)}`));
		DOM.append(add, DOM.$('span', undefined, localize('dispatchMachines.add', "Add machine...")));
		store.add(DOM.addDisposableListener(add, DOM.EventType.CLICK, () => run(a => a.get(ICommandService).executeCommand(DISPATCH_MACHINES_ADD))));
		const manage = DOM.append(footer, DOM.$('button.dispatch-machines-panel-footer-action.end'));
		DOM.append(manage, DOM.$(`span${ThemeIcon.asCSSSelector(Codicon.settingsGear)}`));
		DOM.append(manage, DOM.$('span', undefined, localize('dispatchMachines.manage', "Manage...")));
		store.add(DOM.addDisposableListener(manage, DOM.EventType.CLICK, () => run(a => a.get(ICommandService).executeCommand(DISPATCH_MACHINES_MANAGE))));
		return panel;
	}

	private renderSection(parent: HTMLElement, m: IDispatchMachine, isThisWindow: boolean, isThisMac: boolean, store: DisposableStore, run: (fn: (accessor: ServicesAccessor) => unknown) => void): void {
		const section = DOM.append(parent, DOM.$('section.dispatch-machines-section'));
		section.classList.toggle('offline', !m.online);
		const head = DOM.append(section, DOM.$('.dispatch-machines-section-head'));
		DOM.append(head, DOM.$(`span.dispatch-machines-section-icon${ThemeIcon.asCSSSelector(Codicon.vm)}`));
		DOM.append(head, DOM.$('span.dispatch-machines-section-name', undefined, m.name));
		if (isThisMac) {
			DOM.append(head, DOM.$('span.dispatch-machines-section-sub', undefined, localize('dispatchMachines.thisMac', "This Mac")));
		}
		const state = DOM.append(head, DOM.$('span.dispatch-machines-section-state'));
		if (isThisWindow) {
			DOM.append(state, DOM.$(`span${ThemeIcon.asCSSSelector(Codicon.check)}`));
			DOM.append(state, DOM.$('span', undefined, localize('dispatchMachines.thisWindow', "This window")));
		} else {
			DOM.append(state, machineMark(m.online ? 'online' : 'offline'));
			DOM.append(state, DOM.$('span', undefined, m.online ? localize('dispatchMachines.onlineState', "Online") : localize('dispatchMachines.offlineState', "Offline")));
		}

		// what is going on there
		const n = waitingCount(m.attention);
		const running = m.working ?? m.running ?? 0;
		const facts: string[] = [];
		if (n) {
			const kinds = attentionSummary(m.attention);
			facts.push(isThisWindow ? localize('dispatchMachines.waitingShort', "waiting for you") : kinds ? localize('dispatchMachines.waitingKinds', "waiting for you · {0}", kinds) : localize('dispatchMachines.waitingShort', "waiting for you"));
		}
		if (running) {
			facts.push(localize('dispatchMachines.running', "{0} running", running));
		}
		if (m.online && (n || running)) {
			const line = DOM.append(section, DOM.$('.dispatch-machines-section-line'));
			if (n) {
				DOM.append(line, machineMark('waiting'));
				DOM.append(line, DOM.$('span.dispatch-machines-count', undefined, String(n)));
				DOM.append(line, DOM.$('span', undefined, ` ${facts.join(' · ')}`));
			} else {
				DOM.append(line, DOM.$('span', undefined, facts.join(' · ')));
			}
		}
		if (!m.online) {
			const since = clockTime(m.last_seen);
			DOM.append(section, DOM.$('.dispatch-machines-section-text', undefined, since
				? localize('dispatchMachines.offlineSince', "Not reachable since {0}. It may be asleep or off Tailscale. Agents there keep running if it only lost the network.", since)
				: localize('dispatchMachines.offlineNow', "Not reachable. It may be asleep or off Tailscale. Agents there keep running if it only lost the network.")));
		}
		if (isThisWindow) {
			return;
		}
		const action = DOM.append(section, DOM.$('button.dispatch-machines-pill'));
		DOM.append(action, DOM.$(`span${ThemeIcon.asCSSSelector(m.online ? Codicon.linkExternal : Codicon.refresh)}`));
		const label = DOM.append(action, DOM.$('span', undefined, m.online ? localize('dispatchMachines.openWindow', "Open window") : localize('dispatchMachines.tryAgain', "Try again")));
		if (m.online) {
			// an open window on it: switch to it
			void this.hasWindow(m).then(open => {
				if (open) {
					label.textContent = localize('dispatchMachines.switchWindow', "Switch to window");
				}
			});
		}
		store.add(DOM.addDisposableListener(action, DOM.EventType.CLICK, () => {
			if (m.online) {
				run(a => openMachineWindow(a, m.id));
			} else {
				label.textContent = localize('dispatchMachines.checking', "Checking...");
				void this.commandService.executeCommand('dispatch.machines', 'refresh', m.id).then(undefined, () => undefined).then(() => refreshDispatchMachines(this.commandService));
			}
		}));

		const recent = (m.recent?.length ? m.recent : m.online ? [] : lastRecent.get(m.id) ?? []).slice(0, 3);
		if (recent.length) {
			DOM.append(section, DOM.$('.dispatch-machines-recent-head', undefined, localize('dispatchMachines.recent', "Recent")));
			for (const r of recent) {
				const row = DOM.append(section, DOM.$<HTMLButtonElement>('button.dispatch-machines-recent-row'));
				row.disabled = !m.online;
				DOM.append(row, DOM.$(`span.dispatch-machines-recent-icon${ThemeIcon.asCSSSelector(Codicon.folder)}`));
				DOM.append(row, DOM.$('span.dispatch-machines-recent-name', undefined, r.label || r.name));
				DOM.append(row, DOM.$('span.dispatch-machines-recent-title', undefined, r.last_title ?? ''));
				DOM.append(row, DOM.$('span.dispatch-machines-recent-time', undefined, ago(r.last_at)));
				// the whole name, its last session and its folder: our card, beside the panel
				store.add(setupDispatchTextHover(this.hoverService, row, () => ({ head: r.label || r.name, text: r.last_title, notes: [r.dir ?? ''] }), { when: () => true, position: HoverPosition.LEFT }));
				if (m.online && r.dir) {
					store.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => run(a => openMachineWindow(a, m.id, r.dir))));
				}
			}
		}
	}

	private async hasWindow(m: IDispatchMachine): Promise<boolean> {
		return this.instantiationService.invokeFunction(async accessor => {
			const nativeHostService = accessor.get(INativeHostService);
			const remote = !!accessor.get(IWorkbenchEnvironmentService).remoteAuthority;
			const onClient = clientMachine(dispatchMachines.get(), remote)?.id === m.id;
			const windows = await nativeHostService.getWindows({ includeAuxiliaryWindows: false });
			const current = await nativeHostService.getActiveWindowId();
			return windows.some(w => {
				if (w.id === current) {
					return false;
				}
				const uri = w.workspace && 'uri' in w.workspace ? URI.revive(w.workspace.uri) : undefined;
				const authority = w.remoteAuthority ?? (uri?.scheme === 'vscode-remote' ? uri.authority : undefined);
				return onClient ? !authority : !!authority && authority === m.authority;
			});
		});
	}
}

// ---- adding a machine: four steps in the quick input ---------------------------------------------------------

interface IFound { readonly name: string; readonly ip?: string; readonly address?: string; readonly os?: string; readonly online?: boolean; readonly supported?: boolean; readonly known?: boolean; readonly via?: string; readonly suggested_name?: string }
interface ICheckStep { readonly step?: string; readonly state?: string; readonly detail?: string; readonly fix?: string; readonly done?: boolean; readonly ok?: boolean; readonly suggested_name?: string; readonly summary?: string; readonly known?: boolean; readonly id?: string }

const STEP_LABEL: Record<string, { todo: string; ok: string; fail: string }> = {
	reach: { todo: localize('dispatchMachines.stepReach', "Reach it"), ok: localize('dispatchMachines.stepReachOk', "Reached it"), fail: localize('dispatchMachines.stepReachFail', "Can't reach that Mac") },
	login: { todo: localize('dispatchMachines.stepLogin', "Sign in with your SSH key"), ok: localize('dispatchMachines.stepLoginOk', "Signed in with your SSH key"), fail: localize('dispatchMachines.stepLoginFail', "Could not sign in") },
	dispatch: { todo: localize('dispatchMachines.stepDispatch', "Look for Dispatch there"), ok: localize('dispatchMachines.stepDispatchOk', "Found Dispatch"), fail: localize('dispatchMachines.stepDispatchFail', "Dispatch is not on that Mac") },
	engines: { todo: localize('dispatchMachines.stepEngines', "Claude Code and Codex"), ok: localize('dispatchMachines.stepEnginesOk', "Claude Code and Codex"), fail: localize('dispatchMachines.stepEnginesFail', "No Claude Code or Codex there") },
};

type AddStep = 'which' | 'user' | 'check' | 'name';
const BACK = Symbol('back');

async function addMachine(accessor: ServicesAccessor): Promise<void> {
	const quickInputService = accessor.get(IQuickInputService);
	const commandService = accessor.get(ICommandService);
	const notificationService = accessor.get(INotificationService);
	const instantiationService = accessor.get(IInstantiationService);
	const icon = (c: ThemeIcon) => ThemeIcon.asClassName(c);

	let found: IFound[] | undefined;
	let target: IFound | undefined;
	let user = '';
	let password: string | undefined;
	let last: ICheckStep | undefined;
	let steps: ICheckStep[] = [];
	let step: AddStep = 'which';
	const address = () => target!.ip || target!.name;

	// 1/4 which Mac: the Macs found on Tailscale and this Wi-Fi, or a typed name or address
	const askWhich = () => new Promise<IFound | undefined>(resolve => {
		type FoundItem = IQuickPickItem & { found?: IFound };
		const pick = quickInputService.createQuickPick<FoundItem>({ useSeparators: true });
		pick.title = localize('dispatchMachines.addTitle', "Add a machine");
		pick.step = 1;
		pick.totalSteps = 4;
		pick.placeholder = localize('dispatchMachines.addPlaceholder', "Tailscale name or IP address");
		pick.busy = !found;
		const fill = () => {
			const items: Array<FoundItem | IQuickPickSeparator> = [];
			const typed = pick.value.trim();
			if (typed) {
				items.push({ label: typed, iconClass: icon(Codicon.vm), description: localize('dispatchMachines.useTyped', "Connect to this address"), found: { name: typed, ip: typed } });
			}
			const tail = (found ?? []).filter(f => f.via !== 'lan');
			const lan = (found ?? []).filter(f => f.via === 'lan');
			items.push({ type: 'separator', label: localize('dispatchMachines.onTailscale', "On your Tailscale network") });
			for (const f of tail) {
				const can = f.supported !== false && !f.known;
				items.push({
					label: f.name,
					iconClass: icon(Codicon.vm),
					description: [f.ip, f.supported !== false ? 'macOS' : localize('dispatchMachines.notSupported', "{0}, not supported yet", /^win/i.test(f.os ?? '') ? 'Windows' : f.os ?? ''), f.known ? localize('dispatchMachines.alreadyAdded', "already added") : f.online === false ? localize('dispatchMachines.offlineWord', "offline") : localize('dispatchMachines.onlineWord', "online")].filter(Boolean).join(' · '),
					found: can ? f : undefined,
				});
			}
			items.push({ type: 'separator', label: localize('dispatchMachines.onWifi', "On this Wi-Fi") });
			if (lan.length) {
				for (const f of lan) {
					items.push({ label: f.name, iconClass: icon(Codicon.vm), description: [f.ip, f.known ? localize('dispatchMachines.alreadyAdded', "already added") : ''].filter(Boolean).join(' · '), found: f.known ? undefined : f });
				}
			} else {
				items.push({ label: localize('dispatchMachines.noLan', "No other Mac with Remote Login found"), iconClass: icon(Codicon.radioTower) });
			}
			pick.items = items;
			// Enter goes to the first Mac that can be added
			const first = items.find(i => i.type !== 'separator' && !!(i as FoundItem).found) as FoundItem | undefined;
			if (first) {
				pick.activeItems = [first];
			}
		};
		if (!found) {
			void commandService.executeCommand<IFound[]>('dispatch.machines', 'discover').then(r => {
				found = Array.isArray(r) ? r.map(f => ({ ...f, ip: f.ip ?? f.address })) : [];
			}, () => { found = []; }).finally(() => { pick.busy = false; fill(); });
		}
		fill();
		pick.onDidChangeValue(() => fill());
		pick.onDidAccept(() => {
			const item = pick.activeItems[0];
			if (!item?.found) {
				return; // a Mac that cannot be added (Windows, already added) or the empty-list line: stay here
			}
			resolve(item.found);
			pick.hide();
		});
		pick.onDidHide(() => { resolve(undefined); pick.dispose(); });
		pick.show();
	});

	// 2/4 the account on that Mac
	const askUser = () => new Promise<string | typeof BACK | undefined>(resolve => {
		const box = quickInputService.createInputBox();
		box.title = localize('dispatchMachines.addUserTitle', "Add a machine · {0}", target!.name);
		box.step = 2;
		box.totalSteps = 4;
		box.buttons = [quickInputService.backButton];
		box.value = user;
		box.prompt = localize('dispatchMachines.addUserPrompt', "The account you sign in with on that Mac.");
		box.onDidChangeValue(v => { box.validationMessage = !v.trim() || /^[A-Za-z0-9._-]+$/.test(v.trim()) ? undefined : localize('dispatchMachines.addUserInvalid', "A user name like apple"); });
		box.onDidTriggerButton(b => { if (b === quickInputService.backButton) { resolve(BACK); box.hide(); } });
		box.onDidAccept(() => {
			const v = box.value.trim();
			if (v && /^[A-Za-z0-9._-]+$/.test(v)) {
				resolve(v);
				box.hide();
			}
		});
		box.onDidHide(() => { resolve(undefined); box.dispose(); });
		box.show();
	});

	// 3/4 check the connection: one line per check, a spinner while they run, the reason and the fix on a failure
	type CheckItem = IQuickPickItem & { again?: boolean };
	const checkItems = (running: boolean): CheckItem[] => {
		const byStep = new Map(steps.filter(x => x.step).map(x => [x.step!, x]));
		let spinning = false;
		const items: CheckItem[] = [];
		for (const [key, label] of Object.entries(STEP_LABEL)) {
			const x = byStep.get(key);
			if (!x) {
				const spin: boolean = running && !spinning;
				spinning = spinning || spin;
				items.push({ label: spin ? `${label.todo}...` : label.todo, iconClass: icon(spin ? ThemeIcon.modify(Codicon.loading, 'spin') : Codicon.circleLargeOutline) });
			} else if (x.state === 'ok') {
				items.push({ label: label.ok, iconClass: icon(Codicon.check), description: key === 'reach' || key === 'dispatch' ? x.detail : undefined });
			} else if (x.state === 'need_password') {
				items.push({ label: localize('dispatchMachines.noKey', "No key yet: sign in once to set one up"), iconClass: icon(Codicon.key) });
			} else {
				items.push({ label: label.fail, iconClass: icon(Codicon.error), detail: x.fix || x.detail });
			}
		}
		return items;
	};
	const runCheck = () => new Promise<'ok' | 'password' | typeof BACK | undefined>(resolve => {
		const check = quickInputService.createQuickPick<CheckItem>();
		check.title = localize('dispatchMachines.addCheckTitle', "Checking {0}@{1}", user, address());
		check.step = 3;
		check.totalSteps = 4;
		check.hideInput = true;
		check.buttons = [quickInputService.backButton];
		let settled = false;
		const done = (v: 'ok' | 'password' | typeof BACK | undefined) => {
			if (!settled) {
				settled = true;
				resolve(v);
				check.hide();
			}
		};
		const go = async () => {
			check.busy = true;
			steps = [];
			check.items = checkItems(true);
			try {
				steps = await commandService.executeCommand<ICheckStep[]>('dispatch.machines', 'check', address(), user, password) ?? [];
			} catch (e) {
				steps = [{ step: 'reach', state: 'fail', detail: String((e as Error)?.message ?? e) }];
			}
			if (settled) {
				return;
			}
			check.busy = false;
			last = steps.find(x => x.done);
			if (last?.ok) {
				done('ok');
				return;
			}
			if (steps.some(x => x.state === 'need_password')) {
				done('password');
				return;
			}
			const again: CheckItem = { label: localize('dispatchMachines.checkAgain', "Check again"), iconClass: icon(Codicon.refresh), again: true };
			check.items = [...checkItems(false), again];
			check.activeItems = [again];
		};
		check.onDidTriggerButton(b => { if (b === quickInputService.backButton) { done(BACK); } });
		check.onDidAccept(() => { if (check.activeItems[0]?.again) { void go(); } });
		check.onDidHide(() => { done(undefined); check.dispose(); });
		check.show();
		void go();
	});

	// the password, once, when that Mac does not know this Mac's key yet
	const askPassword = () => new Promise<string | typeof BACK | undefined>(resolve => {
		const box = quickInputService.createInputBox();
		box.title = localize('dispatchMachines.addCheckTitle', "Checking {0}@{1}", user, address());
		box.step = 3;
		box.totalSteps = 4;
		box.password = true;
		box.buttons = [quickInputService.backButton];
		box.prompt = localize('dispatchMachines.addPasswordPrompt', "Password for {0} on that Mac. Dispatch uses it once to install a key, then forgets it.", user);
		box.onDidTriggerButton(b => { if (b === quickInputService.backButton) { resolve(BACK); box.hide(); } });
		box.onDidAccept(() => {
			if (box.value) {
				resolve(box.value);
				box.hide();
			}
		});
		box.onDidHide(() => { resolve(undefined); box.dispose(); });
		box.show();
	});

	// 4/4 name it: what the checks found, then Open window on it (Enter) or Done
	type NameItem = IQuickPickItem & { action?: 'open' | 'done' };
	const askName = () => new Promise<{ name: string; open: boolean } | typeof BACK | undefined>(resolve => {
		const byStep = new Map(steps.filter(x => x.step).map(x => [x.step!, x]));
		const ready = [byStep.get('dispatch')?.detail, byStep.get('engines')?.detail].filter(Boolean).join(' · ');
		const pick = quickInputService.createQuickPick<NameItem>({ useSeparators: true });
		pick.title = localize('dispatchMachines.addNameTitle', "Name this Mac");
		pick.step = 4;
		pick.totalSteps = 4;
		pick.buttons = [quickInputService.backButton];
		pick.value = last?.suggested_name ?? target!.suggested_name ?? target!.name;
		pick.filterValue = () => ''; // the box holds the name, it does not filter
		pick.sortByLabel = false;
		const calls = target!.name && target!.name !== pick.value ? ` ${localize('dispatchMachines.callsItself', "That Mac calls itself {0}.", target!.name)}` : '';
		pick.placeholder = localize('dispatchMachines.addNamePrompt', "Shown on its window, in the sidebar and in Machines.{0}", calls);
		const fill = () => {
			const name = pick.value.trim();
			const open: NameItem = { label: localize('dispatchMachines.openWindowOn', "Open window on {0}", name || '...'), iconClass: icon(Codicon.linkExternal), action: 'open' };
			const items: Array<NameItem | IQuickPickSeparator> = [{ type: 'separator', label: localize('dispatchMachines.ready', "Ready") }];
			if (ready) {
				items.push({ label: ready, iconClass: icon(Codicon.check) });
			}
			items.push(open, { label: localize('dispatchMachines.addDone', "Done"), iconClass: icon(Codicon.blank), action: 'done' });
			pick.items = items;
			pick.activeItems = [open];
			pick.validationMessage = name ? undefined : localize('dispatchMachines.addNameEmpty', "Give it a name");
		};
		fill();
		pick.onDidChangeValue(() => fill());
		pick.onDidTriggerButton(b => { if (b === quickInputService.backButton) { resolve(BACK); pick.hide(); } });
		pick.onDidAccept(() => {
			const action = pick.activeItems[0]?.action;
			const name = pick.value.trim();
			if (!action || !name) {
				return;
			}
			resolve({ name, open: action === 'open' });
			pick.hide();
		});
		pick.onDidHide(() => { resolve(undefined); pick.dispose(); });
		pick.show();
	});

	for (; ;) {
		if (step === 'which') {
			const t = await askWhich();
			if (!t?.ip && !t?.name) {
				return;
			}
			target = t;
			step = 'user';
		} else if (step === 'user') {
			const u = await askUser();
			if (u === BACK) {
				step = 'which';
				continue;
			}
			if (!u) {
				return;
			}
			user = u;
			password = undefined;
			step = 'check';
		} else if (step === 'check') {
			const r = await runCheck();
			if (r === BACK) {
				step = 'user';
				continue;
			}
			if (r === 'password') {
				const pw = await askPassword();
				if (pw === BACK) {
					step = 'user';
					continue;
				}
				if (!pw) {
					return;
				}
				password = pw;
				continue; // check again, installing the key with it
			}
			if (r !== 'ok') {
				return;
			}
			password = undefined;
			if (last?.known && last.id) {
				// already one of the machines: nothing to add, its window is what the user is after
				const id = last.id;
				notificationService.info(localize('dispatchMachines.alreadyThere', "{0} is already one of your machines.", target!.name));
				await instantiationService.invokeFunction(a => openMachineWindow(a, id));
				return;
			}
			step = 'name';
		} else {
			const r = await askName();
			if (r === BACK) {
				step = 'check';
				continue;
			}
			if (!r) {
				return;
			}
			const saved = await commandService.executeCommand<{ ok?: boolean; id?: string; message?: string }>('dispatch.machines', 'add', address(), user, r.name);
			if (!saved?.ok || !saved.id) {
				notificationService.warn(saved?.message || localize('dispatchMachines.addFailed', "Could not add {0}.", r.name));
				return;
			}
			const id = saved.id;
			await refreshDispatchMachines(commandService);
			if (r.open) {
				await instantiationService.invokeFunction(a => openMachineWindow(a, id));
			}
			return;
		}
	}
}

CommandsRegistry.registerCommand(DISPATCH_MACHINES_ADD, accessor => addMachine(accessor));

// ---- managing machines: the Agents window has a page (sessions code sets it); elsewhere a quick pick ---------

let manageHandler: ((accessor: ServicesAccessor) => unknown) | undefined;
/** The Agents window shows its machines page here. */
export function setManageMachinesHandler(handler: (accessor: ServicesAccessor) => unknown): void {
	manageHandler = handler;
}

export async function editMachine(accessor: ServicesAccessor, m: IDispatchMachine, what: 'rename' | 'address' | 'remove'): Promise<void> {
	const quickInputService = accessor.get(IQuickInputService);
	const commandService = accessor.get(ICommandService);
	const notificationService = accessor.get(INotificationService);
	let answer: { ok?: boolean; message?: string } | undefined;
	if (what === 'rename') {
		const name = await quickInputService.input({ title: localize('dispatchMachines.renameTitle', "Rename {0}", m.name), value: m.name, prompt: localize('dispatchMachines.renamePrompt', "One name for this Mac everywhere: its window, the sidebar, Machines.") });
		if (!name?.trim() || name.trim() === m.name) {
			return;
		}
		answer = await commandService.executeCommand('dispatch.machines', 'set', m.id, { name: name.trim() });
	} else if (what === 'address') {
		const address = await quickInputService.input({ title: localize('dispatchMachines.addressTitle', "Address of {0}", m.name), value: m.ssh ?? '', prompt: localize('dispatchMachines.addressPrompt', "user@address, as ssh takes it") });
		if (!address?.trim() || address.trim() === m.ssh) {
			return;
		}
		const [user, host] = address.includes('@') ? address.trim().split('@', 2) : [m.user ?? '', address.trim()];
		answer = await commandService.executeCommand('dispatch.machines', 'set', m.id, { address: host, user });
	} else {
		const sure = await quickInputService.pick([{ label: localize('dispatchMachines.removeYes', "Remove {0}", m.name), id: 'yes' }, { label: localize('dispatchMachines.removeNo', "Cancel"), id: 'no' }], { title: localize('dispatchMachines.removeTitle', "Remove {0} from your machines? Nothing on that Mac changes.", m.name) });
		if (sure?.id !== 'yes') {
			return;
		}
		answer = await commandService.executeCommand('dispatch.machines', 'remove', m.id);
	}
	if (answer && answer.ok === false) {
		notificationService.warn(answer.message || localize('dispatchMachines.editFailed', "That did not work."));
	}
	await refreshDispatchMachines(commandService);
}

CommandsRegistry.registerCommand(DISPATCH_MACHINES_MANAGE, async accessor => {
	if (manageHandler) {
		await manageHandler(accessor);
		return;
	}
	const quickInputService = accessor.get(IQuickInputService);
	const instantiationService = accessor.get(IInstantiationService);
	const list = dispatchMachines.get() ?? [];
	type Item = IQuickPickItem & { m?: IDispatchMachine; what?: 'rename' | 'address' | 'remove' };
	const items: Array<Item | IQuickPickSeparator> = [];
	for (const m of list) {
		items.push({ type: 'separator', label: m.name });
		items.push({ label: localize('dispatchMachines.rename', "Rename..."), m, what: 'rename' });
		if (!m.local) {
			items.push({ label: localize('dispatchMachines.address', "Change address..."), description: m.ssh, m, what: 'address' });
			items.push({ label: localize('dispatchMachines.remove', "Remove..."), m, what: 'remove' });
		}
	}
	const chosen = await quickInputService.pick(items, { title: localize('dispatchMachines.manageTitle', "Manage machines") }) as Item | undefined;
	if (chosen?.m && chosen.what) {
		await instantiationService.invokeFunction(a => editMachine(a, chosen.m!, chosen.what!));
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dispatch.machines.openPicker', title: localize2('dispatchMachines.openPicker', "Machines: Open a Machine's Window"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const instantiationService = accessor.get(IInstantiationService);
		const commandService = accessor.get(ICommandService);
		await refreshDispatchMachines(commandService);
		const list = (dispatchMachines.get() ?? []).filter(m => !m.local);
		const picks: Array<IQuickPickItem & { id: string }> = list.map(m => ({ label: `$(vm) ${m.name}`, description: m.online ? attentionSummary(m.attention) : localize('dispatchMachines.offlineWord', "offline"), id: m.id }));
		const chosen = await quickInputService.pick(picks, { canPickMany: false });
		if (chosen?.id) {
			await instantiationService.invokeFunction(a => openMachineWindow(a, chosen.id!));
		}
	}
});

// ---- the contribution ----------------------------------------------------------------------------------------

class DispatchMachinesContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'dispatch.contrib.machines';
	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICommandService commandService: ICommandService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IRemoteAgentService remoteAgentService: IRemoteAgentService,
		@IStorageService storageService: IStorageService,
	) {
		super();
		setMachineStorage(storageService);
		this._register(storageService.onDidChangeValue(StorageScope.APPLICATION_SHARED, undefined, this._store)(e => {
			if (!e.key.startsWith('dispatch.machines.preparation.')) { return; }
			const rec = parsePreparation(storageService.get(e.key, StorageScope.APPLICATION_SHARED));
			if (rec?.owner !== mainWindow.vscodeWindowId) { return; }
			const authority = e.key.slice('dispatch.machines.preparation.'.length);
			if (rec.stage === 'cancelled') { void commandService.executeCommand('dispatch.machines', 'cancel', authority); }
			if (rec.retry) { void commandService.executeCommand('dispatch.machines', 'prepare', rec.host, { land: rec.land }); }
		}));
		for (const menu of [MenuId.for('SessionsTitleBarSessionMenu'), MenuId.TitleBar]) {
			this._register(actionViewItemService.register(menu, DISPATCH_MACHINES_BUTTON, action => instantiationService.createInstance(DispatchMachinesButton, action)));
		}
		if (environmentService.remoteAuthority) {
			connectionState.set('connecting', undefined);
			const connection = remoteAgentService.getConnection();
			if (connection) {
				this._register(connection.onDidStateChange(e => {
					switch (e.type) {
						case PersistentConnectionEventType.ConnectionLost:
						case PersistentConnectionEventType.ReconnectionRunning:
						case PersistentConnectionEventType.ReconnectionWait:
							connectionState.set('reconnecting', undefined);
							break;
						case PersistentConnectionEventType.ReconnectionPermanentFailure:
							connectionState.set('disconnected', undefined);
							break;
						case PersistentConnectionEventType.ConnectionGain:
							connectionState.set('connected', undefined);
							break;
					}
				}));
			}
			void remoteAgentService.getEnvironment().then(env => { if (connectionState.get() === 'connecting') { connectionState.set(env ? 'connected' : 'disconnected', undefined); } }, () => { connectionState.set('disconnected', undefined); });
		}
		const first = mainWindow.setTimeout(() => void refreshDispatchMachines(commandService), 2500);
		const timer = mainWindow.setInterval(() => {
			if (mainWindow.document.visibilityState === 'visible') {
				void refreshDispatchMachines(commandService);
			}
		}, POLL_MS);
		// no list yet (the extension host was still starting): ask again every 5 s until there is one
		const early = mainWindow.setInterval(() => {
			if (dispatchMachines.get()) {
				mainWindow.clearInterval(early);
			} else {
				void refreshDispatchMachines(commandService);
			}
		}, 5000);
		this._register(toDisposable(() => { mainWindow.clearTimeout(first); mainWindow.clearInterval(timer); mainWindow.clearInterval(early); }));
		this._register(DOM.addDisposableListener(mainWindow, 'focus', () => void refreshDispatchMachines(commandService, true)));
	}
}
// BlockRestore: the title bars read their view items once, when they are built
registerWorkbenchContribution2(DispatchMachinesContribution.ID, DispatchMachinesContribution, WorkbenchPhase.BlockRestore);
