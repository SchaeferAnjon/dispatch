/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the harness chip of a running session.
 *
 *  VS Code only lets the harness (Claude / Codex) be picked before the first message. Dispatch
 *  lets the user switch mid-conversation: picking the other harness here does not change this
 *  session, it asks the dispatch-bridge extension (`dispatch.switchAgent`) to start a new session
 *  in the same folder with the conversation handed over, and archive this one.
 *  `_dispatch.startSession` is the internal command the extension uses to start that session.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { BaseActionViewItem } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { autorun, IObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IActionListDelegate, IActionListItem, ActionListItemKind } from '../../../../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { IActionViewItemService } from '../../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { IsSessionsWindowContext } from '../../../../../workbench/common/contextkeys.js';
import { ChatContextKeyExprs } from '../../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { IsPhoneLayoutContext } from '../../../../common/contextkeys.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../../common/agentHostSessionsProvider.js';
import { ISessionContext } from '../../../../services/sessions/browser/sessionContext.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ChatModelSource, ISession, ISessionType, SessionStatus } from '../../../../services/sessions/common/session.js';
import { ISessionsProvider } from '../../../../services/sessions/common/sessionsProvider.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { timeout } from '../../../../../base/common/async.js';
import { getStoredSelectedModel } from '../../../../../workbench/contrib/chat/common/chatSelectedModel.js';
import { ChatAgentLocation } from '../../../../../workbench/contrib/chat/common/constants.js';
import { dispatchDefaultModel, dispatchSwitchModel, ISwitchLink } from './dispatchSwitchModel.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';

const HARNESS_PICKER_ACTION_ID = 'dispatch.harnessPicker';
const SWITCH_AGENT_COMMAND_ID = 'dispatch.switchAgent';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: HARNESS_PICKER_ACTION_ID,
			title: localize2('dispatch.harnessPicker', "Agent Harness"),
			f1: false,
			menu: [{
				id: MenuId.ChatInput,
				group: 'navigation',
				order: 0,
				when: ContextKeyExpr.and(ChatContextKeyExprs.isAgentHostSession, IsSessionsWindowContext, IsPhoneLayoutContext.negate()),
			}],
		});
	}
	override async run(): Promise<void> { /* handled by the action view item */ }
});

interface IHarnessItem {
	readonly sessionTypeId: string;
}

class HarnessPickerActionViewItem extends BaseActionViewItem {

	private readonly _renderStore = this._register(new DisposableStore());

	// Dispatch IDE (input-chips-narrow): the input's responsive layout folds this chip to its icon when the row is
	// too narrow (the toolbar marks it .compact-picker), as it does the model picker; the label stays in the aria label
	private _compact = false;
	isCompact(): boolean {
		return this._compact;
	}
	setCompact(compact: boolean): void {
		this._compact = compact;
	}

	constructor(
		private readonly _session: IObservable<ISession | undefined>,
		@IActionWidgetService private readonly _actionWidgetService: IActionWidgetService,
		@ISessionsProvidersService private readonly _providers: ISessionsProvidersService,
		@ICommandService private readonly _commandService: ICommandService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ISessionsManagementService private readonly _management: ISessionsManagementService,
	) {
		super(undefined, { id: HARNESS_PICKER_ACTION_ID, label: '', enabled: true, class: undefined, tooltip: '', run: () => { } });
	}

	private _types(session: ISession): ISessionType[] {
		const folder = session.workspace.get()?.uri;
		const provider = this._providers.getProvider(session.providerId);
		if (!folder || !provider) {
			return [];
		}
		try {
			return provider.getSessionTypes(folder);
		} catch {
			return [];
		}
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('chat-input-picker-item', 'dispatch-harness-picker-item');
		// same slot / label / chevron classes as the agent picker next to it, so it is styled like it
		const slot = dom.append(container, dom.$('.sessions-chat-picker-slot'));
		const trigger = dom.append(slot, dom.$('a.action-label.dispatch-harness-picker'));
		trigger.tabIndex = 0;
		trigger.role = 'button';
		const paint = (session: ISession | undefined) => {
			dom.clearNode(trigger);
			if (!session) {
				return;
			}
			const current = this._types(session).find(t => t.id === session.sessionType);
			dom.append(trigger, renderIcon(current?.icon ?? session.icon));
			dom.append(trigger, dom.$('span.sessions-chat-dropdown-label', undefined, current?.label ?? session.sessionType));
			dom.append(trigger, renderIcon(Codicon.chevronDownCompact)).classList.add('sessions-chat-dropdown-chevron');
			trigger.ariaLabel = localize('dispatch.harnessPicker.aria', "Agent harness, {0}. Pick another to continue this conversation there", current?.label ?? session.sessionType);
		};
		this._renderStore.add(autorun(reader => paint(this._session.read(reader))));
		const open = (e: Event) => {
			dom.EventHelper.stop(e, true);
			this._show(trigger);
		};
		this._renderStore.add(dom.addDisposableListener(trigger, dom.EventType.CLICK, open));
		this._renderStore.add(dom.addDisposableListener(trigger, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter' || e.key === ' ') {
				open(e);
			}
		}));
	}

	private _show(anchor: HTMLElement): void {
		const session = this._session.get();
		if (!session || this._actionWidgetService.isVisible) {
			return;
		}
		const items: IActionListItem<IHarnessItem>[] = this._types(session).map(t => ({
			kind: ActionListItemKind.Action,
			label: t.label,
			group: { title: '', icon: t.icon },
			item: { sessionTypeId: t.id },
			...(t.id === session.sessionType ? { checked: true } : {}),
		}));
		const delegate: IActionListDelegate<IHarnessItem> = {
			onSelect: async item => {
				this._actionWidgetService.hide();
				if (item.sessionTypeId === session.sessionType) {
					return;
				}
				if (session.status.get() === SessionStatus.InProgress) {
					this._notificationService.info(localize('dispatch.harnessPicker.busy', "Wait for this turn to finish (or stop it), then switch."));
					return;
				}
				try {
					const started = await this._commandService.executeCommand<string>(SWITCH_AGENT_COMMAND_ID, session.resource.toString(), item.sessionTypeId, session.workspace.get()?.uri.toString());
					if (started) {
						// the old conversation (now in Archived) says where it went, as Dispatch's session list does
						const target = this._types(session).find(t => t.id === item.sessionTypeId)?.label ?? item.sessionTypeId;
						await this._management.renameSession(session, localize('dispatch.harnessPicker.switchedTitle', "Switched to {0}: {1}", target, session.title.get()));
					}
				} catch (err) {
					this._notificationService.error(localize('dispatch.harnessPicker.failed', "Could not switch the agent: {0}", String((err as Error)?.message ?? err)));
				}
			},
			onHide: () => anchor.isConnected && anchor.focus(),
		};
		this._actionWidgetService.show<IHarnessItem>(
			'dispatchHarnessPicker', false, items, delegate, anchor, undefined, [],
			{ getAriaLabel: e => e.label ?? '', getWidgetAriaLabel: () => localize('dispatch.harnessPicker.list', "Agent Harness") },
			{ className: 'sessions-new-chat-picker-list', minWidth: 200 },
		);
	}
}

class DispatchHarnessPickerContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'dispatch.contrib.harnessPicker';

	constructor(@IActionViewItemService actionViewItemService: IActionViewItemService) {
		super();
		this._register(actionViewItemService.register(MenuId.ChatInput, HARNESS_PICKER_ACTION_ID, (_action, _options, scoped: IInstantiationService) => {
			const { session } = scoped.invokeFunction(accessor => accessor.get(ISessionContext));
			return scoped.createInstance(HarnessPickerActionViewItem, session);
		}));
	}
}

registerWorkbenchContribution2(DispatchHarnessPickerContribution.ID, DispatchHarnessPickerContribution, WorkbenchPhase.AfterRestored);

const SWITCH_LINKS_KEY = 'dispatch.switchAgent.links';

function readSwitchLinks(storage: IStorageService): Record<string, ISwitchLink> {
	try {
		const links = JSON.parse(storage.get(SWITCH_LINKS_KEY, StorageScope.PROFILE) ?? '{}');
		return links && typeof links === 'object' ? links : {};
	} catch {
		return {};
	}
}

/**
 * Sets the model the new session starts on before its first message, once the harness lists its models (10 s
 * at most): `modelId` when the harness offers it, else the harness's declared default (dispatchDefaultModel).
 * Returns what it set.
 */
async function applySwitchModel(provider: ISessionsProvider, session: ISession, modelId: string | undefined, log: ILogService): Promise<string | undefined> {
	for (let waited = 0; waited <= 10000; waited += 250) {
		const snapshot = provider.getModelsSnapshot(session.sessionId, modelId);
		let model: { readonly identifier: string } | undefined;
		if (modelId) {
			const found = snapshot.desiredModelResolution;
			if (found.kind === 'available') {
				model = found.model;
			} else if (found.kind !== 'pending' && snapshot.models.length) {
				log.info(`[dispatch] switch: model ${modelId} is not offered for ${session.sessionType}; its default instead`);
				modelId = undefined;
				continue;
			}
		} else {
			model = dispatchDefaultModel(snapshot.models);
		}
		if (model) {
			provider.setModel(session.sessionId, session.mainChat.get().resource, model.identifier, ChatModelSource.Chosen);
			return model.identifier;
		}
		await timeout(250);
	}
	log.info(`[dispatch] switch: ${session.sessionType} listed no models in 10 s; the harness's default runs`);
	return undefined;
}

/**
 * `_dispatch.startSession({ folderUri, sessionTypeId, prompt, from? })`: start a session of that harness in
 * that folder, in place (no new worktree: the folder already is the old session's worktree, so the
 * new agent sees its uncommitted changes), on the model it should run on (dispatchSwitchModel), send
 * `prompt` as its first message and show it. `from` is the session it continues. Returns the new
 * session's resource.
 */
CommandsRegistry.registerCommand('_dispatch.startSession', async (accessor: ServicesAccessor, args: { folderUri: string; sessionTypeId: string; prompt: string; from?: string }) => {
	const management = accessor.get(ISessionsManagementService);
	const providers = accessor.get(ISessionsProvidersService);
	const storage = accessor.get(IStorageService);
	const log = accessor.get(ILogService);
	const folderUri = URI.parse(args.folderUri);
	const old = args.from ? management.getSession(URI.parse(args.from)) : undefined;
	const session = management.createNewSession(folderUri, { providerId: LOCAL_AGENT_HOST_PROVIDER_ID, sessionTypeId: args.sessionTypeId });
	const provider = providers.getProvider(session.providerId);
	// isolationMode in the create options only reaches harnesses that declare worktree support
	// (Copilot CLI); Claude and Codex take it from the provider directly
	await provider?.setIsolationMode?.(session.sessionId, 'workspace');
	const links = readSwitchLinks(storage);
	// what the old session ran on: its own model, else what its chip showed (a session nobody picked a model for)
	const oldProvider = old ? providers.getProvider(old.providerId) : undefined;
	const oldModel = old?.modelId.get() ?? (old && oldProvider ? dispatchDefaultModel(oldProvider.getModelsSnapshot(old.sessionId).models)?.identifier : undefined);
	const from: ISwitchLink | undefined = args.from ? { from: args.from, type: old?.sessionType ?? '', model: oldModel } : undefined;
	const remembered = provider ? getStoredSelectedModel(storage, ChatAgentLocation.Chat, provider.getModelsSnapshot(session.sessionId).modelTarget) : undefined;
	const wanted = dispatchSwitchModel(links, from, args.sessionTypeId, remembered);
	const modelId = provider ? await applySwitchModel(provider, session, wanted, log) : undefined;
	// the session in the list after its first message has its own resource: the chip names that one at the next switch
	let started: ISession | undefined;
	const listener = management.onDidStartSession(s => { started ??= s; });
	try {
		await management.sendNewChatRequest(session, { query: args.prompt });
	} finally {
		listener.dispose();
	}
	const resource = (started ?? session).resource.toString();
	if (from) {
		const kept = Object.entries({ ...links, [session.resource.toString()]: from, [resource]: from }).slice(-200);
		storage.store(SWITCH_LINKS_KEY, JSON.stringify(Object.fromEntries(kept)), StorageScope.PROFILE, StorageTarget.MACHINE);
	}
	log.info(`[dispatch] started ${args.sessionTypeId} session ${resource} in ${folderUri.toString()} on ${modelId ?? 'its default model'}`);
	return resource;
});

/**
 * `_dispatch.openSession(resource)`: show that session. After a harness switch the old session is
 * archived, and archiving the one on screen sends the window to the new-session page; the extension
 * calls this afterwards so the new session stays selected.
 */
CommandsRegistry.registerCommand('_dispatch.openSession', async (accessor: ServicesAccessor, resource: string) => {
	await accessor.get(ISessionsService).openSession(URI.parse(resource));
});
