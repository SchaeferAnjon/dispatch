/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: open a terminal for a project, run an agent in it, bring over the Ghostty look.
 *
 *  The terminal button above the sessions list (and "Open a Terminal" in the command palette) asks what to
 *  open in the project of the session on screen: a plain terminal, or one of the agents found on the Mac, each
 *  with a line saying what it is. The terminal becomes a session in the list (dispatchTerminalSessionsProvider.ts)
 *  and lives in Dispatch's terminal daemon, so it keeps running when Dispatch is closed.
 *  The first time, when the Mac has Ghostty settings, one question offers to use that look (font, colors, cursor).
 *
 *  GUI stays the default: nothing in the chat sessions changes, the terminal is something a person chooses.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { Action } from '../../../../base/common/actions.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { ISessionSection, SessionSectionTypeContext } from '../../sessions/browser/views/sessionsList.js';
import { showNewSessionPicker } from './dispatchNewPicker.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Menus } from '../../../browser/menus.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { GHOSTTY_ASKED_KEY, ghosttyChanges, ghosttyOfferDetail, IGhosttyPreview } from './dispatchTerminalModel.js';
import { DispatchTerminalSessionsProvider } from './dispatchTerminalSessionsProvider.js';
import './dispatchTerminalView.js';
import './dispatchTerminalOverPage.js';
import './dispatchTerminalActions.js';

class DispatchTerminalProviderContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'dispatch.contrib.terminalProvider';

	constructor(
		@ISessionsProvidersService sessionsProvidersService: ISessionsProvidersService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		const provider = this._register(instantiationService.createInstance(DispatchTerminalSessionsProvider));
		this._register(sessionsProvidersService.registerProvider(provider));
	}
}

registerWorkbenchContribution2(DispatchTerminalProviderContribution.ID, DispatchTerminalProviderContribution, WorkbenchPhase.BlockStartup);

/** The folder a new terminal opens in: where the session on screen works, else the window's own folder. */
function terminalFolder(accessor: ServicesAccessor): URI | undefined {
	const workspace = accessor.get(ISessionsService).activeSession.get()?.workspace.get();
	const folder = workspace?.folders[0];
	const dir = folder?.workingDirectory ?? folder?.root ?? accessor.get(IWorkspaceContextService).getWorkspace().folders[0]?.uri;
	return dir && dir.scheme === Schemas.file ? dir : undefined;
}

// ---- the Ghostty look ---------------------------------------------------------------------------

function inspectUser(configurationService: IConfigurationService, key: string): unknown {
	return configurationService.inspect(key).userValue;
}

/** Writes the Ghostty look into the terminal's settings; returns what puts the old values back. */
async function applyGhosttyLook(configurationService: IConfigurationService, preview: IGhosttyPreview): Promise<() => Promise<void>> {
	const colorKey = 'workbench.colorCustomizations';
	const changes = ghosttyChanges(preview, inspectUser(configurationService, colorKey));
	const before = new Map<string, unknown>();
	for (const key of Object.keys(changes.settings)) {
		before.set(key, inspectUser(configurationService, key));
	}
	if (changes.colorCustomizations) {
		before.set(colorKey, inspectUser(configurationService, colorKey));
	}
	for (const [key, value] of Object.entries(changes.settings)) {
		await configurationService.updateValue(key, value, ConfigurationTarget.USER);
	}
	if (changes.colorCustomizations) {
		await configurationService.updateValue(colorKey, changes.colorCustomizations, ConfigurationTarget.USER);
	}
	return async () => {
		for (const [key, value] of before) {
			await configurationService.updateValue(key, value, ConfigurationTarget.USER);
		}
	};
}

async function readGhostty(commands: ICommandService): Promise<IGhosttyPreview | undefined> {
	try {
		const preview = await commands.executeCommand<IGhosttyPreview>('dispatch.terminal', 'ghostty');
		return preview?.found ? preview : undefined;
	} catch {
		return undefined;
	}
}

async function useGhosttyLook(configurationService: IConfigurationService, notificationService: INotificationService, preview: IGhosttyPreview): Promise<void> {
	const undo = await applyGhosttyLook(configurationService, preview);
	notificationService.notify({
		severity: Severity.Info,
		message: 'Your terminal now uses your Ghostty look.',
		actions: { primary: [new Action('dispatch.terminal.undoGhostty', 'Undo', undefined, true, async () => { await undo(); })] },
	});
}

/** Once, the first time a terminal is opened on a Mac that has Ghostty settings. */
async function offerGhosttyOnce(commands: ICommandService, storageService: IStorageService, dialogService: IDialogService, configurationService: IConfigurationService, notificationService: INotificationService): Promise<void> {
	if (storageService.getBoolean(GHOSTTY_ASKED_KEY, StorageScope.APPLICATION, false)) {
		return;
	}
	const preview = await readGhostty(commands);
	if (!preview) {
		return;
	}
	storageService.store(GHOSTTY_ASKED_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);
	const { confirmed } = await dialogService.confirm({
		type: 'question',
		message: 'Use your Ghostty look in Dispatch\'s terminal?',
		detail: ghosttyOfferDetail(preview),
		primaryButton: 'Use my Ghostty look',
		cancelButton: 'Not now',
	});
	if (confirmed) {
		await useGhosttyLook(configurationService, notificationService, preview);
	}
}

// ---- open a terminal ----------------------------------------------------------------------------

/** Where the panel opens for a keyboard shortcut: under the top of the sessions list. */
function sidebarAnchor(): { x: number; y: number } {
	const bar = mainWindow.document.querySelector('.part.sidebar');
	const r = bar?.getBoundingClientRect();
	return r ? { x: r.left + 16, y: r.top + 44 } : { x: 120, y: 80 };
}

registerAction2(class OpenTerminalAction extends Action2 {
	constructor() {
		super({
			id: 'dispatch.terminal.open',
			title: localize2('dispatch.terminal.open', "Open a Terminal"),
			category: localize2('dispatch.terminal.category', "Dispatch"),
			icon: Codicon.terminal,
			f1: true,
			// Dispatch IDE (terminal-key-anywhere): ⌘T opens a terminal wherever the focus is in the Agents window, the side
			// pane's files and changes included (it was off there and did nothing, though Settings says ⌘T opens a terminal)
			keybinding: { weight: KeybindingWeight.SessionsContrib, when: IsSessionsWindowContext, primary: KeyMod.CtrlCmd | KeyCode.KeyT },
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const folder = terminalFolder(accessor);
		if (!folder) {
			accessor.get(INotificationService).info('Open a session in a project first, then open its terminal.');
			return;
		}
		await showNewSessionPicker(accessor, folder, 'terminal', sidebarAnchor());
	}
});

registerAction2(class NewSessionOrTerminalAction extends Action2 {
	constructor() {
		super({
			id: 'dispatch.session.newPicker',
			title: localize2('dispatch.session.newPicker', "New Session or Terminal..."),
			category: localize2('dispatch.terminal.category', "Dispatch"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const folder = terminalFolder(accessor);
		if (!folder) {
			accessor.get(INotificationService).info('Open a session in a project first.');
			return;
		}
		await showNewSessionPicker(accessor, folder, undefined, sidebarAnchor());
	}
});

registerAction2(class NewTerminalInFolderAction extends Action2 {
	constructor() {
		super({
			id: 'dispatch.terminal.newInFolder',
			title: localize2('dispatch.terminal.newInFolder', "New Terminal..."),
			icon: Codicon.terminal,
			menu: { id: Menus.SessionSectionNewSession, group: 'navigation', order: 1, when: SessionSectionTypeContext.isEqualTo('workspace') },
		});
	}

	async run(accessor: ServicesAccessor, section?: ISessionSection): Promise<void> {
		const ws = section?.sessions[0]?.workspace.get()?.folders[0];
		const folder = ws?.workingDirectory ?? ws?.root ?? terminalFolder(accessor);
		if (folder) {
			await showNewSessionPicker(accessor, folder, 'terminal');
		}
	}
});

// the new-session panel asks the one-time Ghostty question before a terminal opens (dispatchNewPicker.ts)
CommandsRegistry.registerCommand('_dispatch.terminal.offerGhostty', accessor => offerGhosttyOnce(
	accessor.get(ICommandService), accessor.get(IStorageService), accessor.get(IDialogService), accessor.get(IConfigurationService), accessor.get(INotificationService)));

registerAction2(class UseGhosttyLookAction extends Action2 {
	constructor() {
		super({
			id: 'dispatch.terminal.useGhostty',
			title: localize2('dispatch.terminal.useGhostty', "Use My Ghostty Look in the Terminal"),
			category: localize2('dispatch.terminal.category', "Dispatch"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const commands = accessor.get(ICommandService);
		const configurationService = accessor.get(IConfigurationService);
		const notificationService = accessor.get(INotificationService);
		const preview = await readGhostty(commands);
		if (!preview) {
			notificationService.info('Dispatch did not find Ghostty settings on this Mac.');
			return;
		}
		await useGhosttyLook(configurationService, notificationService, preview);
	}
});
