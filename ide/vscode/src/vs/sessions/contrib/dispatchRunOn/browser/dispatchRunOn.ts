/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: "Run on", the first chip on the new session page (kanban task-qb6j, design/run-on). It says which
 *  computer the new session runs on: This Mac by default, or one of your other Macs (Settings › Macs, hosts.json).
 *  Picking another Mac connects this window to that Mac's agents over SSH (VS Code's SSH agent host, started there
 *  with Dispatch IDE's own server: platform/agentHost/common/dispatchAgentHostCommand.ts) after dispatch-bridge has
 *  copied the server over (`dispatch.machines runOn`), then asks for a folder there, its recent projects first. The
 *  session then runs on that Mac: its files, its agents and their logins. In the sessions list such a session
 *  carries the machine tag (DESIGN.md「机器标签」) and is grouped by its folder (`dispatchMachineOfSession`).
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, IObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ActionListItemKind, IActionListDelegate, IActionListItem } from '../../../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetService } from '../../../../platform/actionWidget/browser/actionWidget.js';
import { agentHostAuthority, toAgentHostUri } from '../../../../platform/agentHost/common/agentHostUri.js';
import { ISSHRemoteAgentHostService, SSHAuthMethod, type ISSHAgentHostConfig } from '../../../../platform/agentHost/common/sshRemoteAgentHost.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { DISPATCH_MACHINES_ADD, dispatchMachines, refreshDispatchMachines } from '../../../../workbench/contrib/dispatchMachines/browser/dispatchMachines.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IAgentHostSessionsProvider, isAgentHostProvider } from '../../../common/agentHostSessionsProvider.js';
import { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { choicesKey, connectFailure, IRunOnChoice, IRunOnMachine, machineIdForName, recentFolders, runOnChoices, THIS_MAC } from './dispatchRunOnModel.js';
import './media/dispatchRunOn.css';

const LAST_LOCAL_KEY = 'dispatch.runOn.lastLocalFolder';

/** Sessions provider id → the name of the Mac it runs on, for every provider that is another Mac over SSH. */
const remoteProviders = observableValue<ReadonlyMap<string, string>>('dispatchRunOnProviders', new Map());

function remoteMachineProvider(p: { id: string }): p is IAgentHostSessionsProvider {
	return isAgentHostProvider(p as never) && !!(p as IAgentHostSessionsProvider).remoteAddress;
}

/** The Mac a session runs on when it is not this one (its name), else undefined. Reads observably. */
export function dispatchMachineOfSession(session: ISession, reader?: Parameters<IObservable<unknown>['read']>[0]): string | undefined {
	const map = reader ? remoteProviders.read(reader) : remoteProviders.get();
	return map.get(session.providerId);
}

/** Keeps the provider → machine map in step with the providers this window has. */
class DispatchRunOnProviders extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.dispatchRunOnProviders';

	constructor(@ISessionsProvidersService providers: ISessionsProvidersService) {
		super();
		const update = () => {
			const map = new Map<string, string>();
			for (const p of providers.getProviders()) {
				if (remoteMachineProvider(p)) {
					map.set(p.id, p.label);
				}
			}
			remoteProviders.set(map, undefined);
		};
		this._register(providers.onDidChangeProviders(update));
		update();
	}
}

registerWorkbenchContribution2(DispatchRunOnProviders.ID, DispatchRunOnProviders, WorkbenchPhase.AfterRestored);

/** Draws the chip first in the new session page's picker row; disposing removes it. */
export function renderDispatchRunOn(row: HTMLElement, session: IObservable<ISession | undefined>, instantiationService: IInstantiationService): IDisposable {
	return instantiationService.createInstance(DispatchRunOnChip, row, session);
}

class DispatchRunOnChip extends Disposable {
	private readonly slot: HTMLElement;
	private readonly trigger: HTMLElement;
	private readonly busy = observableValue<string | undefined>(this, undefined);
	private menuShown = false;

	constructor(
		row: HTMLElement,
		private readonly session: IObservable<ISession | undefined>,
		@IActionWidgetService private readonly actionWidgetService: IActionWidgetService,
		@ICommandService private readonly commandService: ICommandService,
		@ISSHRemoteAgentHostService private readonly sshService: ISSHRemoteAgentHostService,
		@ISessionsProvidersService private readonly providers: ISessionsProvidersService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@ISessionsPartService private readonly sessionsPartService: ISessionsPartService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@INotificationService private readonly notificationService: INotificationService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
	) {
		super();
		this.slot = dom.$('.sessions-chat-picker-slot.sessions-workspace-category-picker-slot.dispatch-run-on');
		this.trigger = dom.append(this.slot, dom.$('a.action-label', { tabindex: '0', role: 'button', 'aria-haspopup': 'listbox' }));
		if (environmentService.remoteAuthority) {
			return; // a window on another Mac: the machine is the window's (DESIGN.md「多台机器」)
		}
		row.prepend(this.slot);
		this._register({ dispose: () => this.slot.remove() });
		this._register(dom.addDisposableListener(this.trigger, dom.EventType.CLICK, e => { dom.EventHelper.stop(e, true); void this.open(); }));
		this._register(dom.addDisposableListener(this.trigger, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
				dom.EventHelper.stop(e, true);
				void this.open();
			}
		}));
		this._register(autorun(reader => {
			const s = this.session.read(reader);
			const machine = s ? dispatchMachineOfSession(s, reader) : undefined;
			const folder = s?.workspace.read(reader)?.folders[0]?.root;
			if (!machine && folder?.scheme === 'file') {
				this.storageService.store(LAST_LOCAL_KEY, folder.toString(), StorageScope.PROFILE, StorageTarget.MACHINE);
			}
			this.draw(machine, this.busy.read(reader));
		}));
		void refreshDispatchMachines(this.commandService, true);
	}

	private current(): string | undefined {
		const s = this.session.get();
		return s ? dispatchMachineOfSession(s) : undefined;
	}

	private draw(machine: string | undefined, busy: string | undefined): void {
		dom.clearNode(this.trigger);
		const label = busy ?? machine ?? localize('dispatchRunOn.thisMac', "This Mac");
		this.trigger.append(renderIcon(busy ? Codicon.loading : Codicon.vm));
		this.trigger.classList.toggle('busy', !!busy);
		dom.append(this.trigger, dom.$('span.sessions-chat-dropdown-label', undefined, label));
		const chevron = dom.append(this.trigger, renderIcon(Codicon.chevronDownCompact));
		chevron.classList.add('sessions-chat-dropdown-chevron');
		chevron.setAttribute('aria-hidden', 'true');
		this.trigger.setAttribute('aria-label', localize('dispatchRunOn.aria', "Run on: {0}", label));
		this.trigger.title = machine
			? localize('dispatchRunOn.tipThere', "The session runs on {0}: its files, its agents and their sign-ins. This Mac only shows the conversation.", machine)
			: localize('dispatchRunOn.tipHere', "Which computer the session runs on. Pick one of your other Macs to work on its files with its agents.");
		this.slot.dataset.machine = machine ?? THIS_MAC;
	}

	private async open(): Promise<void> {
		if (this.busy.get()) {
			return;
		}
		// a Mac added a moment ago (Settings › Macs, or `dispatch machines add`) is in the menu: ask again, also when this
		// window asked a few seconds ago (a quiet refresh would skip that). A list this window already has waits at most
		// a moment for the newer one; a window that has none yet (asking your Macs can take a few seconds) shows the menu
		// at once with Looking for your other Macs. Either way the open menu is drawn again when the answer differs.
		// A question already on its way (the window's first, asked before that Mac was added) is joined, not asked
		// again, so one more question follows it.
		const fresh = refreshDispatchMachines(this.commandService);
		const after = fresh.then(() => refreshDispatchMachines(this.commandService));
		if (dispatchMachines.get() !== undefined) {
			await raceTimeout(fresh, 1500);
		}
		if (!this.trigger.isConnected) {
			return;
		}
		let looking = dispatchMachines.get() === undefined;
		let shown = choicesKey(dispatchMachines.get() as readonly IRunOnMachine[] | undefined);
		this.showMenu(looking);
		const redraw = () => {
			const now = dispatchMachines.get() as readonly IRunOnMachine[] | undefined;
			if (this.menuShown && this.trigger.isConnected && !this.busy.get() && (looking || choicesKey(now) !== shown)) {
				looking = false;
				shown = choicesKey(now);
				this.showMenu(false);
			}
		};
		void fresh.then(redraw);
		void after.then(redraw);
	}

	private showMenu(looking: boolean): void {
		const machines = dispatchMachines.get() as readonly IRunOnMachine[] | undefined;
		const current = machineIdForName(this.current(), machines);
		const items: IActionListItem<IRunOnChoice | 'add'>[] = runOnChoices(machines, current ?? THIS_MAC).map(c => ({
			kind: ActionListItemKind.Action,
			label: c.label,
			description: c.description,
			group: { title: '', icon: c.local ? Codicon.vm : Codicon.remote },
			hover: c.local ? undefined : { content: localize('dispatchRunOn.hoverThere', "The agent runs on {0} and works on its files. This Mac only shows the conversation, so it can sleep or close.", c.label) },
			item: { ...c },
			...(c.checked ? { checked: true } : {}),
		} as IActionListItem<IRunOnChoice | 'add'>));
		if (looking) {
			items.push({ kind: ActionListItemKind.Action, label: localize('dispatchRunOn.looking', "Looking for your other Macs..."), group: { title: '', icon: Codicon.loading }, disabled: true, item: 'add' });
		}
		items.push({ kind: ActionListItemKind.Separator, label: '' });
		items.push({ kind: ActionListItemKind.Action, label: localize('dispatchRunOn.add', "Add another Mac..."), group: { title: '', icon: Codicon.add }, item: 'add' });
		const delegate: IActionListDelegate<IRunOnChoice | 'add'> = {
			onSelect: item => {
				this.actionWidgetService.hide();
				if (item === 'add') {
					void this.commandService.executeCommand(DISPATCH_MACHINES_ADD);
				} else if (item.local) {
					this.backHome();
				} else {
					void this.runOn(item.id, item.label);
				}
			},
			onHide: () => {
				this.menuShown = false;
				if (this.trigger.isConnected) {
					this.trigger.focus();
				}
			},
		};
		this.actionWidgetService.show<IRunOnChoice | 'add'>('dispatchRunOn', false, items, delegate, this.trigger, undefined, [], {
			getAriaLabel: e => e.label ?? '',
			getWidgetAriaLabel: () => localize('dispatchRunOn.widget', "Run on"),
		}, { className: 'sessions-new-chat-picker-list', minWidth: 220 });
		this.menuShown = true;
	}

	/** This Mac again: the last folder used here, else the most recent one the picker knows. */
	private backHome(): void {
		if (!this.current()) {
			return;
		}
		const last = this.storageService.get(LAST_LOCAL_KEY, StorageScope.PROFILE);
		const uri = last ? URI.parse(last) : undefined;
		const view = this.sessionsPartService.getSessionView(this.sessionsService.activeSession.get()?.sessionId);
		if (uri && view) {
			view.selectWorkspace(uri);
		} else {
			void this.commandService.executeCommand('workbench.action.sessions.newSession.pickFolderQuickPick').catch(() => undefined);
		}
	}

	private async runOn(id: string, name: string): Promise<void> {
		this.busy.set(localize('dispatchRunOn.connecting', "Connecting to {0}...", name), undefined);
		try {
			const ready = await this.commandService.executeCommand<{ ok?: boolean; ssh?: string; name?: string; message?: string }>('dispatch.machines', 'runOn', id);
			if (!ready?.ok || !ready.ssh) {
				throw new Error(ready?.message || localize('dispatchRunOn.noBridge', "Dispatch could not get {0} ready.", name));
			}
			const resolved = await this.sshService.resolveSSHConfig(ready.ssh);
			const config: ISSHAgentHostConfig = {
				host: resolved.hostname,
				port: resolved.port !== 22 ? resolved.port : undefined,
				username: resolved.user || ready.ssh.split('@')[0],
				authMethod: SSHAuthMethod.Agent,
				privateKeyPath: resolved.identityFile[0],
				identityAgent: resolved.identityAgent,
				name: ready.name || name,
				sshConfigHost: ready.ssh,
				userInitiated: true,
			};
			// A connection this window already has to that Mac is used as it is: connecting again makes VS Code replace
			// it, and the first answer of that replacement can fail ("Method not found: initialize") although its own
			// reconnect is back a few seconds later. Should a connect fail like that, that reconnect is waited for.
			const mine = (c: { config: { sshConfigHost?: string; host: string; username?: string } }) => c.config.sshConfigHost === ready.ssh || (c.config.host === config.host && (c.config.username ?? '') === (config.username ?? ''));
			let provider = await this.providerOn(mine, 1);
			if (!provider) {
				try {
					const connection = await this.sshService.connect(config);
					provider = await this.providerFor(connection.localAddress);
				} catch (e) {
					provider = await this.providerOn(mine, 60);
					if (!provider) {
						throw e;
					}
				}
			}
			if (!provider) {
				throw new Error(localize('dispatchRunOn.noProvider', "{0} answered but offered no agents.", name));
			}
			this.busy.set(undefined, undefined);
			await this.pickFolder(id, name, provider);
		} catch (e) {
			this.busy.set(undefined, undefined);
			this.notificationService.error(connectFailure(name, String((e as Error)?.message ?? e)));
		}
	}

	/** The agents of a connection this window has to that Mac, asked `tries` times a quarter second apart. */
	private async providerOn(mine: (c: { config: { sshConfigHost?: string; host: string; username?: string } }) => boolean, tries: number): Promise<IAgentHostSessionsProvider | undefined> {
		for (let i = 0; i < tries; i++) {
			const c = this.sshService.connections.find(mine);
			const p = c && this.providers.getProviders().find((x): x is IAgentHostSessionsProvider => remoteMachineProvider(x) && x.remoteAddress === c.localAddress);
			if (p) {
				return p;
			}
			if (i + 1 < tries) {
				await new Promise(r => setTimeout(r, 250));
			}
		}
		return undefined;
	}

	private async providerFor(address: string): Promise<IAgentHostSessionsProvider | undefined> {
		for (let i = 0; i < 40; i++) {
			const p = this.providers.getProviders().find((x): x is IAgentHostSessionsProvider => remoteMachineProvider(x) && x.remoteAddress === address);
			if (p) {
				return p;
			}
			await new Promise(r => setTimeout(r, 250));
		}
		return undefined;
	}

	/** A folder on that Mac: its recent projects first, or any folder there. */
	private async pickFolder(id: string, name: string, provider: IAgentHostSessionsProvider): Promise<void> {
		const machines = dispatchMachines.get() as readonly IRunOnMachine[] | undefined;
		const recent = recentFolders(machines?.find(m => m.id === id));
		type Pick = IQuickPickItem & { dir?: string };
		const picks: Pick[] = recent.map(r => ({ label: r.label, description: r.dir, dir: r.dir }));
		picks.push({ label: localize('dispatchRunOn.other', "Choose another folder on {0}...", name), alwaysShow: true });
		const picked = recent.length
			? await this.quickInputService.pick<Pick>(picks, { title: localize('dispatchRunOn.folderTitle', "Which folder on {0}?", name), placeHolder: localize('dispatchRunOn.folderHint', "The agent works in this folder on {0}", name) })
			: picks[0];
		if (!picked) {
			return;
		}
		let uri: URI | undefined;
		if (picked.dir) {
			uri = toAgentHostUri(URI.file(picked.dir), agentHostAuthority(provider.remoteAddress!));
		} else {
			uri = (await provider.browseActions[0]?.run())?.folders[0]?.root;
		}
		if (!uri) {
			return;
		}
		this.sessionsPartService.getSessionView(this.sessionsService.activeSession.get()?.sessionId)?.selectWorkspace(uri);
	}
}

/** The sessions list: a session on another Mac ends its row with that Mac's tag. */
export function renderRunOnRowTag(titleRow: HTMLElement, session: ISession, store: DisposableStore): void {
	let tag = titleRow.querySelector<HTMLElement>(':scope > .dispatch-run-on-row-tag');
	if (!tag) {
		tag = dom.$('span.dispatch-run-on-row-tag.dispatch-machine-tag');
		titleRow.insertBefore(tag, titleRow.querySelector(':scope > .session-title-toolbar'));
	}
	const machineTag = tag;
	store.add(autorun(reader => {
		const machine = dispatchMachineOfSession(session, reader);
		dom.clearNode(machineTag);
		machineTag.style.display = machine ? '' : 'none';
		if (machine) {
			dom.append(machineTag, dom.$(`span.dispatch-machine-tag-icon${ThemeIcon.asCSSSelector(Codicon.vm)}`));
			dom.append(machineTag, dom.$('span', undefined, machine));
			machineTag.title = localize('dispatchRunOnRowTag', "Runs on {0}", machine);
		}
	}));
	store.add(toDisposable(() => machineTag.style.display = 'none'));
}
