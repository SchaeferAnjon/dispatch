/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: first-run setup (kanban design/onboarding/redesign, direction A; patches/
 *  505-onboarding.patch). A Mac with nothing set up opens the Agents window on a four screen
 *  wizard (two when there is nothing to bring over): agents and history, folders, preferences,
 *  rules. Skip leaves a "Set up" pill where What's new sits; "Set up Dispatch" runs the choices in
 *  order and lands on the New session page with a toast (What was imported / Undo).
 *
 *  The work is the CLI's (`dispatch onboard`, through dispatch-bridge's `dispatch.onboarding`); the
 *  page only collects choices. State is module level: a custom view is disposed whenever another one
 *  is shown.
 *--------------------------------------------------------------------------------------------*/

import '../../../../workbench/contrib/chat/browser/agentSessions/dispatchEngineIcons.js';
// the first three suggestions on a new chat's page, where setup lands
import './dispatchFirstPrompts.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import * as DOM from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IExtensionGalleryService, VerifyExtensionSignatureConfigKey } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import product from '../../../../platform/product/common/product.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IWorkbenchExtensionManagementService } from '../../../../workbench/services/extensionManagement/common/extensionManagement.js';
import { IAction } from '../../../../base/common/actions.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, constObservable, IObservable } from '../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { AICustomizationManagementCommands } from '../../../../workbench/contrib/chat/common/aiCustomizationWorkspaceService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ChatConfiguration } from '../../../../workbench/contrib/chat/common/constants.js';
import { UpdateTitleBarContext } from '../../../../workbench/contrib/update/common/update.js';
import { Menus } from '../../../browser/menus.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { registerOnboardingMigrations } from './dispatchOnboardingMigrations.js';
import { OnboardingController, OnboardingPage } from './dispatchOnboardingPage.js';
import { applyAutonomy, loadAgentChoice, onDidChangeAgentChoice } from '../../dispatchAgents/browser/dispatchAgents.js';
import { ThemeMode } from '../../dispatchAgents/browser/dispatchFirstRunModel.js';
import { DISPATCH_NOTIFY_TEST_COMMAND, INotifyTestAnswer } from '../../dispatchAgents/browser/dispatchNotifyTest.js';
import { DISPATCH_TOOLS_VIEW_ID, DispatchToolsView, IToolsAnswer } from './dispatchOnboardingTools.js';
import { OPENCODE_ADD_PROVIDER_COMMAND } from '../../../../workbench/contrib/chat/browser/agentSessions/opencodeStatus.js';
import { ExternalRange, IOnboardingHost, IOnboardingStatus, OnboardingStep } from './dispatchOnboardingModel.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ISessionsRecentWorkspacesService } from '../../../services/sessions/browser/sessionsRecentWorkspacesService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { URI } from '../../../../base/common/uri.js';
import { askGitIdentity } from '../../dispatchCommon/browser/dispatchGitIdentity.js';

export const DISPATCH_ONBOARDING_VIEW_ID = 'dispatch.onboarding';
const SHOW_COMMAND = 'dispatch.onboarding.show';
const NEW_SESSION_COMMAND = 'workbench.action.sessions.newChat';
/** A new chat without a folder (the "+" on Chats, sessionsViewActions.ts). */
const NEW_CHAT_COMMAND = 'sessionsView.newQuickChat';
const OPEN_MIGRATIONS_COMMAND = 'dispatch.onboarding.openMigrations';
const SetupPending = new RawContextKey<boolean>('dispatchSetupPending', false);
/** The setup page is on screen (SetupPending is false then: the title bar's Set up is not offered over it). */
const SetupShown = new RawContextKey<boolean>('dispatchSetupShown', false);
/** Set while the first-run setup is ahead on this Mac (and on the very first start of the app): the next start shows the
 *  setup page at once, before the CLI answers (task-lj06.25: a new Mac waited 20 to 35 s on a page it could type into). */
const SETUP_DUE_KEY = 'dispatch.onboarding.due';
/** The window asks again whether an agent needs connecting when it gets focus back, not more often than this. */
const CONNECT_CHECK_MS = 15_000;

let controller: OnboardingController | undefined;
let contribution: DispatchOnboardingContribution | undefined;

// ---------------------------------------------------------------- the view

class DispatchOnboardingView extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('dispatchOnboarding.viewTitle', "Set up Dispatch"));
	override readonly maxWidth = 680;
	private page: OnboardingPage | undefined;
	constructor(@IContextViewService private readonly contextViewService: IContextViewService) { super(); }

	render(container: HTMLElement): void {
		container.classList.add('dispatch-onboarding-host');
		if (!controller) {
			return;
		}
		this.page = this._register(new OnboardingPage(controller, this.contextViewService));
		this.page.render(container);
	}

	layout(_width: number, height: number): void {
		this.page?.layout(height);
	}

	override focus(): void {
		this.page?.focus();
	}
}

// ---------------------------------------------------------------- the title bar pill

class SetupTitleBarItem extends BaseActionViewItem {

	constructor(action: IAction, options: IBaseActionViewItemOptions | undefined) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('dispatch-setup-entry');
		container.setAttribute('role', 'button');
		container.setAttribute('aria-label', localize('dispatchOnboarding.pillAria', "Finish setting up Dispatch"));
		const indicator = DOM.append(container, DOM.$('.update-indicator.dispatch-setup'));
		DOM.append(indicator, DOM.$('.indicator-label', undefined, localize('dispatchOnboarding.pill', "Set up")));
	}
}

// ---------------------------------------------------------------- wiring

class DispatchOnboardingContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dispatchOnboarding';

	private readonly pending: IContextKey<boolean>;
	private readonly shown: IContextKey<boolean>;
	private readonly holder = this._register(new MutableDisposable<OnboardingController>());
	private checked = false;
	private incomplete = false;
	private welcomeAfterWizard = false;
	/** Set up is in the title bar for an agent installed after setup that has no Dispatch block yet (kanban task-vgll). */
	private connectOnly = false;
	private connectCheckedAt = 0;
	/** The wizard is on its way (open() waits for the CLI before the page shows): Set up is not offered meanwhile. */
	private opening = false;
	/** New on setup's landing chat goes to the folder from before setup (see backToFolder) */
	private readonly afterLanding = this._register(new MutableDisposable());

	constructor(
		@ICustomViewService private readonly customViewService: ICustomViewService,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILogService private readonly logService: ILogService,
		@IStorageService private readonly storageService: IStorageService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ISessionsRecentWorkspacesService private readonly recentWorkspacesService: ISessionsRecentWorkspacesService,
		@ISessionsService private readonly sessionsService: ISessionsService,
	) {
		super();
		this.pending = SetupPending.bindTo(contextKeyService);
		this.shown = SetupShown.bindTo(contextKeyService);
		this._register(registerOnboardingMigrations(commandService, notificationService));
		this._register(customViewService.registerCustomView({
			id: DISPATCH_ONBOARDING_VIEW_ID,
			ctor: new SyncDescriptor(DispatchOnboardingView),
		}, { restore: false }));
		// Dispatch IDE: Apple's command line tools first, on a Mac without them (dispatchOnboardingTools.ts)
		this._register(customViewService.registerCustomView({
			id: DISPATCH_TOOLS_VIEW_ID,
			ctor: new SyncDescriptor(DispatchToolsView),
		}, { restore: false }));
		contribution = this;
		this._register({ dispose: () => { contribution = undefined; controller = undefined; } });
		this.fresh();
		this._register(autorun(reader => {
			customViewService.activeCustomView.read(reader);
			this.syncPending();
		}));

		this._register(MenuRegistry.appendMenuItem(Menus.TitleBarLeftLayout, {
			command: { id: SHOW_COMMAND, title: localize('dispatchOnboarding.pill', "Set up") },
			group: 'navigation',
			order: 4,
			when: ContextKeyExpr.and(SetupPending, UpdateTitleBarContext.toNegated()),
		}));
		this._register(actionViewItemService.register(Menus.TitleBarLeftLayout, SHOW_COMMAND, (action, options) => new SetupTitleBarItem(action, options), undefined));

		// once the workbench is up: is there anything to set up? On the app's first start (or while setup is still ahead)
		// the page shows at once, saying it is looking at this Mac, until the CLI answers
		const early = storageService.isNew(StorageScope.APPLICATION) || storageService.getBoolean(SETUP_DUE_KEY, StorageScope.APPLICATION, false);
		const timer = mainWindow.setTimeout(() => void this.check(early), early ? 0 : 1200);
		this._register({ dispose: () => mainWindow.clearTimeout(timer) });
		// an agent installed while the app runs (a Terminal, the new-session page): Set up comes back to connect it
		const onFocus = () => { if (this.checked && Date.now() - this.connectCheckedAt > CONNECT_CHECK_MS) { void this.checkConnect(); } };
		mainWindow.addEventListener('focus', onFocus);
		this._register({ dispose: () => mainWindow.removeEventListener('focus', onFocus) });
		// ... and when the agents on this Mac change without the window losing focus (Install on the new-session page)
		this._register(onDidChangeAgentChoice(() => { if (this.checked) { void this.checkConnect(); } }));
	}

	/** The step the title bar's Set up opens: the last page (Connect Dispatch to …) when that is all that is left. */
	pillStep(): OnboardingStep | undefined {
		return this.connectOnly ? 'rules' : undefined;
	}

	/**
	 * After setup (done or skipped): is an agent of Dispatch's on this Mac without its rules block and hooks? The wizard's
	 * last page tells someone without agents to install one and run Set up again from the title bar; this is what puts
	 * Set up there (`dispatch onboard unconnected`, a `which` and a file read per agent).
	 */
	private async checkConnect(): Promise<void> {
		this.connectCheckedAt = Date.now();
		if (this.customViewService.activeCustomView.get()?.id === DISPATCH_ONBOARDING_VIEW_ID) {
			return;
		}
		try {
			const answer = await this.commandService.executeCommand<{ state: string; agents: { id: string; name: string }[] }>('dispatch.onboarding', 'unconnected');
			if (!answer || answer.state === 'pending') {
				return;
			}
			const want = answer.agents.length > 0;
			if (answer.state === 'done' && want !== this.connectOnly) {
				this.connectOnly = want;
				this.incomplete = want;
				this.syncPending();
			}
		} catch (e) {
			this.logService.trace(`[DispatchOnboarding] unconnected: ${e}`);
		}
	}

	/** A controller with nothing chosen yet (the first one, and again after a finished run). */
	private fresh(): OnboardingController {
		const c = new OnboardingController(this.host());
		this.holder.value = c;
		controller = c;
		return c;
	}

	/** Shows the wizard: where it stopped, or from the start after a finished run. It shows at once ("Looking at this
	 *  Mac") and fills in when the CLI answers. `known`: the status the caller already read. */
	async open(step?: OnboardingStep, known?: IOnboardingStatus): Promise<void> {
		this.incomplete = true;
		// Set up stays off from the moment the wizard is asked for (the Command Palette's Set Up Dispatch, the pill
		// itself) until it is left: it used to light up while the page was on its way (kanban task-bp58a)
		this.opening = true;
		this.syncPending();
		try {
			let c = controller;
			if (!c || c.phase === 'finished') {
				c = this.fresh();
			}
			this.customViewService.showCustomView(DISPATCH_ONBOARDING_VIEW_ID);
			await c.start(step, known);
		} finally {
			this.opening = false;
			this.syncPending();
		}
	}

	/** The one place that says whether the title bar offers Set up: something is left to do and the wizard is not up. */
	private syncPending(): void {
		const onScreen = this.customViewService.activeCustomView.get()?.id === DISPATCH_ONBOARDING_VIEW_ID;
		this.pending.set(this.incomplete && !this.opening && !onScreen);
		this.shown.set(onScreen || this.opening);
	}

	private host(): IOnboardingHost {
		const ask = async <T>(op: string, arg?: unknown, extra?: unknown): Promise<T> => {
			// first-run answers that are not the wizard's own: how much agents may do on their own, notifications, keep awake
			const result: unknown = op === 'autonomy-set' ? await applyAutonomy(this.commandService, this.configurationService, this.storageService, (arg as { level: string }).level)
				: op === 'notify-set' || op === 'awake-set' || op === 'git-identity-set' ? await this.commandService.executeCommand<T>('dispatch.firstRun', op, arg)
					: await this.commandService.executeCommand<T>('dispatch.onboarding', op, arg, extra);
			if ((result as { ok?: boolean })?.ok === false) { throw new Error((result as { message?: string }).message || 'Setup could not finish.'); }
			if (op === 'agents-use') {
				// the new session picker follows the choice at once (it would otherwise read it on the next focus)
				await loadAgentChoice(this.commandService).catch(() => false);
			}
			if (result === undefined) { throw new Error('Dispatch did not answer. Retry setup.'); }
			return result as T;
		};
		return {
			ask,
			installEngine: async id => {
				// a failed install says why (kanban task-jvtg): the answer was dropped and the row just went back to Install
				const answer = await this.commandService.executeCommand<{ ok?: boolean; message?: string; command?: string }>('dispatch.engines', 'upgrade', id);
				if (!answer?.ok) {
					throw new Error([answer?.message || 'Dispatch did not answer.', answer?.command ? `You can also run ${answer.command} in a terminal.` : ''].filter(Boolean).join(' '));
				}
			},
			signIn: async id => (await this.commandService.executeCommand<{ ok: boolean; message: string }>('dispatch.engines', 'login', id)) ?? { ok: false, message: 'Dispatch did not answer.' },
			firstRun: async <T>(op: string, arg?: unknown) => (await this.commandService.executeCommand<T>('dispatch.firstRun', op, arg)) as T,
			notifyTest: async () => (await this.commandService.executeCommand<INotifyTestAnswer>(DISPATCH_NOTIFY_TEST_COMMAND))!,
			addProvider: async () => { await this.commandService.executeCommand(OPENCODE_ADD_PROVIDER_COMMAND); },
			getTheme: async () => (await this.commandService.executeCommand<{ mode: ThemeMode }>('_dispatch.theme.get'))?.mode ?? 'system',
			setTheme: async mode => { await this.commandService.executeCommand('_dispatch.theme.set', mode); },
			setExternalRange: async (mode: ExternalRange) => {
				await this.configurationService.updateValue(ChatConfiguration.ShowExternalAgentSessions, mode);
				this.storageService.store('sessions.externalSessionBanner.dismissed', true, StorageScope.PROFILE, StorageTarget.USER);
			},
			refresh: async () => { await this.commandService.executeCommand('dispatch.projects', 'page').then(undefined, () => undefined); },
			notify: message => this.notificationService.info(message),
			leave: done => this.leave(done),
			askGitIdentity: start => askGitIdentity(this.quickInputService, start),
		};
	}

	/**
	 * First open: the wizard, once, when the CLI says a Mac has nothing set up. `early` (the app's first start, or setup
	 * was still ahead last time): the page is up before the CLI answers, which on a new Mac can take half a minute
	 * (the extension host and the CLI starting), and goes again if there is nothing to set up after all.
	 */
	private async check(early = false): Promise<void> {
		if (this.checked) {
			return;
		}
		this.checked = true;
		const shownEarly = early && !this.customViewService.activeCustomView.get();
		if (shownEarly) {
			this.welcomeAfterWizard = true;
			this.opening = true;
			this.syncPending();
			this.fresh();
			this.customViewService.showCustomView(DISPATCH_ONBOARDING_VIEW_ID);
		}
		// a new Mac: no python3 for the CLI and no git until Apple's command line tools are in. Their page comes first;
		// the window starts again once they are, with setup still due
		const tools = await this.commandService.executeCommand<IToolsAnswer>('dispatch.onboarding', 'tools').catch(() => undefined);
		if (tools && !tools.ok) {
			this.storageService.store(SETUP_DUE_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
			this.opening = false;
			this.customViewService.showCustomView(DISPATCH_TOOLS_VIEW_ID);
			this.syncPending();
			return;
		}
		let status: IOnboardingStatus | undefined;
		try {
			status = await this.commandService.executeCommand<IOnboardingStatus>('dispatch.onboarding', 'status');
		} catch (e) {
			this.logService.trace(`[DispatchOnboarding] ${e}`);
		}
		this.opening = false;
		if (status?.needed) {
			this.storageService.store(SETUP_DUE_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
			// What's new waits until the wizard is done or skipped: it would open on top of it
			this.welcomeAfterWizard = true;
			await this.open(status.step, status);
			return;
		}
		if (status) {
			this.storageService.remove(SETUP_DUE_KEY, StorageScope.APPLICATION);
		}
		if (shownEarly) {
			// nothing to set up after all (or no answer): the page that was waiting goes, and the window is where it was
			this.welcomeAfterWizard = false;
			if (this.customViewService.activeCustomView.get()?.id === DISPATCH_ONBOARDING_VIEW_ID) {
				this.customViewService.hideCustomView();
			}
		}
		this.syncPending();
		if (!status) {
			return;
		}
		if (status.state === 'skipped') {
			this.incomplete = true;
			this.syncPending();
		} else {
			await this.checkConnect();
		}
	}

	private leave(done: boolean): void {
		this.storageService.remove(SETUP_DUE_KEY, StorageScope.APPLICATION);
		this.incomplete = !done;
		this.connectOnly = false;
		this.customViewService.hideCustomView();
		const welcome = this.welcomeAfterWizard;
		this.welcomeAfterWizard = false;
		this.syncPending();
		// the way in is a new chat (2026-11-11 direction A, task-0v1o9: the Assistant is gone): its page carries the
		// first three suggestions (dispatchFirstPrompts.ts), "Check my projects for unfinished work" first; without
		// chats (no agent host) a new session. What's new comes once that page is up, so its card is placed clear of
		// the page's message box (it sat on a box that came up under it)
		// the chat is where setup lands, not a choice of the person's: New afterwards starts in the folder it did before
		// (the picker remembers "No workspace" the moment the chat page picks it)
		const kept = this.recentWorkspacesService.isNoWorkspaceChecked() ? 'none' : this.recentWorkspacesService.getRecentWorkspaces(false).find(r => r.checked);
		const restore = () => {
			if (kept === 'none') {
				return;
			}
			if (kept) {
				this.recentWorkspacesService.addRecentWorkspace(kept.workspace.uri, kept.providerId, true);
				this.backToFolder(kept.workspace.uri, kept.providerId);
			} else {
				this.recentWorkspacesService.clearCheckedWorkspace();
			}
		};
		const landed = done
			? this.commandService.executeCommand(NEW_CHAT_COMMAND).then(undefined, () => this.commandService.executeCommand(NEW_SESSION_COMMAND)).then(restore, restore)
			: Promise.resolve();
		if (welcome) {
			void landed.then(() => new Promise(resolve => mainWindow.setTimeout(resolve, 600))).then(() => this.commandService.executeCommand('dispatch.whatsNew.welcome'));
		}
		// no "Dispatch is set up." toast: the page the person just left said so, and the toast sat on the message box's
		// Turbo (task-lj06.26). What setup changed, each with Undo, is in Settings (the last page says where).
	}

	/**
	 * New on an empty chat page keeps that page (VS Code's composer restores its draft), so New right after setup would
	 * stay on the landing chat: while that draft is the active one and nothing was sent, New opens the folder from before.
	 */
	private backToFolder(folderUri: URI, providerId: string | undefined): void {
		const landing = this.sessionsService.activeSession.get();
		if (!landing?.isQuickChat?.get()) {
			return;
		}
		this.afterLanding.value = this.commandService.onDidExecuteCommand(e => {
			if (e.commandId !== NEW_SESSION_COMMAND) {
				return;
			}
			mainWindow.setTimeout(() => {
				const active = this.sessionsService.activeSession.get();
				if (active?.sessionId !== landing.sessionId || active.isCreated.get()) {
					this.afterLanding.clear();
					return;
				}
				this.afterLanding.clear();
				void this.sessionsService.openNewSession({ folderUri, providerId });
			}, 0);
		});
	}
}

registerWorkbenchContribution2(DispatchOnboardingContribution.ID, DispatchOnboardingContribution, WorkbenchPhase.BlockRestore);

registerAction2(class extends Action2 {
	constructor() {
		super({ id: SHOW_COMMAND, title: localize2('dispatchOnboarding.showTitle', "Set Up Dispatch"), f1: true });
	}
	async run(_accessor: ServicesAccessor, step?: OnboardingStep): Promise<void> {
		await contribution?.open(step ?? contribution.pillStep());
	}
});

registerAction2(class extends Action2 {
	constructor() { super({ id: OPEN_MIGRATIONS_COMMAND, title: localize2('dispatchOnboarding.migrations', "What Was Imported"), f1: true }); }
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand(AICustomizationManagementCommands.OpenEditor, { migration: true });
	}
});

// Agents does not register the Editor's installExtension command. Use the same native service,
// targeting the application's default profile so imported editor extensions are available in Editor.
registerAction2(class extends Action2 {
	constructor() { super({ id: 'dispatch.onboarding.extensions', title: localize2('dispatchOnboarding.extensions', "Import Editor Extensions"), f1: false }); }
	async run(accessor: ServicesAccessor, op: string, values: unknown): Promise<{ installed: string[]; failed: string[] }> {
		if (op !== 'install' && op !== 'uninstall') { throw new Error('Unknown extension operation'); }
		const ids = Array.isArray(values) ? [...new Set(values.filter((id): id is string => typeof id === 'string' && /^[a-zA-Z0-9][\w-]*\.[\w.-]+$/.test(id)))].slice(0, 200) : [];
		const management = accessor.get(IWorkbenchExtensionManagementService);
		const gallery = accessor.get(IExtensionGalleryService);
		const profile = accessor.get(IUserDataProfilesService).defaultProfile.extensionsResource;
		const logService = accessor.get(ILogService);
		// The Editor registers this setting; Agents uses the product's same configured policy.
		const verify = accessor.get(IConfigurationService).getValue<boolean>(VerifyExtensionSignatureConfigKey) ?? (product as { configurationDefaults?: Record<string, unknown> }).configurationDefaults?.[VerifyExtensionSignatureConfigKey];
		const existing = await management.getInstalled(undefined, profile);
		const installed: string[] = [], failed: string[] = [];
		for (const id of ids) {
			try {
				const local = existing.find(e => e.identifier.id.toLowerCase() === id.toLowerCase());
				if (op === 'uninstall') {
					if (local) { await management.uninstall(local, { profileLocation: profile }); }
				} else if (!local) {
					const [extension] = await gallery.getExtensions([{ id }], CancellationToken.None);
					if (!extension) { throw new Error('Extension is not available on Open VSX'); }
					await management.installFromGallery(extension, { profileLocation: profile, isMachineScoped: true, donotVerifySignature: verify === false });
					installed.push(id);
				}
			} catch (e) {
				logService.warn(`[DispatchOnboarding] ${op} ${id}: ${String(e)}`);
				failed.push(id);
			}
		}
		return { installed, failed };
	}
});
