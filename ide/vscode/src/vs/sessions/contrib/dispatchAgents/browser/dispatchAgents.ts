/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the choice of which agents the person uses, as the Agents window knows it.
 *
 *  The CLI keeps it (`dispatch engines enabled | use`, through dispatch-bridge's `dispatch.engines`).
 *  This module holds the last answer: the agent host's session types leave out an agent that is turned
 *  off (baseAgentHostSessionsProvider.ts asks `isAgentEnabled`), so the new session picker and the
 *  harness chip list only what the person turned on. It is read at start, when the window gets focus
 *  again (the choice may have been changed by the CLI), and set right after the wizard or
 *  Customizations saves it.
 *--------------------------------------------------------------------------------------------*/

import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { SessionStatus } from '../../../services/sessions/common/session.js';
import { applyContinuedApprovals } from '../../dispatchHistory/browser/dispatchContinueApprovals.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { localize } from '../../../../nls.js';
import { IAgentChoice, IAgentRow, isProviderEnabled, noAgentInstalled } from './dispatchAgentsModel.js';
import { IAutonomy } from './dispatchFirstRunModel.js';

/** Where the new session picker remembers the harness picked last (sessionTypePicker.ts). */
const LAST_SESSION_TYPE_KEY = 'sessions.userSelectedSessionType';
/** Where the Agents window remembers the approvals picked in a session (baseAgentHostSessionsProvider.ts). */
const REMEMBERED_SESSION_CONFIG_KEY = 'sessions.agentHost.sessionConfigPicker.selectedValues';

let current: IAgentChoice | undefined;
const changed = new Emitter<void>();
export const onDidChangeAgentChoice = changed.event;
const defaultChanged = new Emitter<void>();
/** The default agent changed: fires before the session types are worked out again. */
export const onDidChangeDefaultAgent = defaultChanged.event;
let beforeDefaultChange: (() => void) | undefined;

/** The agent a new session starts with, '' while none was chosen. */
export function getDefaultAgent(): string {
	return current?.effective || current?.default || '';
}

/**
 * Why a new session cannot be sent, or undefined: none of the agents Dispatch runs is on this Mac, so the message
 * would wait for an answer that never comes, or Enter would do nothing at all (kanban task-6vw2). The new-session
 * page's send asks first.
 */
export function sendBlockedReason(): string | undefined {
	if (noAgentInstalled(current)) {
		return localize('dispatchAgents.noneInstalled', "No agent is on this Mac yet, so nothing can answer. Install one with the button above the input box, then send again.");
	}
	return undefined;
}

/**
 * What the new-session page's agent picker says while none of the agents Dispatch runs is on this Mac, or undefined.
 * It used to name Claude Code, which was not there to answer (kanban task-bp58a); the notice above the input box
 * has the Install buttons.
 */
export function noAgentPickerLabel(): string | undefined {
	return noAgentInstalled(current) ? localize('dispatchAgents.pickerNone', "No agent yet") : undefined;
}

/** The last answer about the agents (undefined until the CLI answered once). */
export function getAgentChoice(): IAgentChoice | undefined {
	return current;
}

/** Is this agent host provider offered for a new session? True until the choice is known. */
export function isAgentEnabled(provider: string): boolean {
	return isProviderEnabled(current, provider);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function setAgentChoice(next: IAgentChoice): void {
	const before = current;
	current = next;
	const dflt = (c: IAgentChoice) => c.effective || c.default;
	if (before && dflt(before) !== dflt(next)) {
		beforeDefaultChange?.();
		defaultChanged.fire();
	}
	if (!before || !sameList(before.off, next.off) || !sameList(before.on, next.on) || dflt(before) !== dflt(next)
		|| !sameList(before.installed ?? [], next.installed ?? []) || !!before.installed !== !!next.installed) {
		changed.fire();
	}
}

function asChoice(answer: unknown): IAgentChoice | undefined {
	const a = answer as Partial<IAgentChoice> | undefined;
	return a && Array.isArray(a.off) && Array.isArray(a.on) ? {
		off: a.off, on: a.on, default: typeof a.default === 'string' ? a.default : '', saved: a.saved === true,
		...(Array.isArray(a.installed) ? { installed: a.installed.filter((x): x is string => typeof x === 'string') } : {}),
		...(typeof a.effective === 'string' ? { effective: a.effective } : {}),
	} : undefined;
}

export async function loadAgentChoice(commands: ICommandService): Promise<boolean> {
	const choice = asChoice(await commands.executeCommand('dispatch.engines', 'enabled'));
	if (choice) {
		setAgentChoice(choice);
	}
	return !!choice;
}

/** Every agent CLI found on this Mac with the choice (`dispatch engines detect`, about a second). */
export async function detectAgents(commands: ICommandService): Promise<readonly IAgentRow[]> {
	const answer = await commands.executeCommand<{ agents?: IAgentRow[] } & Partial<IAgentChoice>>('dispatch.engines', 'detect');
	if (!answer || !Array.isArray(answer.agents)) {
		throw new Error('Dispatch could not look for agents.');
	}
	const choice = asChoice(answer);
	if (choice) {
		setAgentChoice(choice);
	}
	return answer.agents;
}

/** Save the choice (only the fields given); the session pickers follow at once. Throws the CLI's reason when it refuses. */
export async function saveAgentChoice(commands: ICommandService, change: { readonly off?: readonly string[]; readonly on?: readonly string[]; readonly default?: string }): Promise<void> {
	const answer = await commands.executeCommand<{ ok?: boolean; message?: string } & Partial<IAgentChoice>>('dispatch.engines', 'use', undefined, change);
	if (!answer || answer.ok === false) {
		throw new Error(answer?.message || 'Dispatch could not save the choice.');
	}
	const choice = asChoice(answer);
	if (choice) {
		setAgentChoice(choice);
	}
}

class DispatchAgentChoiceContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'dispatch.contrib.agentChoice';

	constructor(@ICommandService private readonly commands: ICommandService, @IStorageService storageService: IStorageService) {
		super();
		// a new default is what the next session starts with, not the harness last picked by hand
		beforeDefaultChange = () => storageService.remove(LAST_SESSION_TYPE_KEY, StorageScope.PROFILE);
		this._register({ dispose: () => { beforeDefaultChange = undefined; } });
		// the bridge may still be starting: try again a few times, then on every focus
		let tries = 0;
		const read = () => {
			loadAgentChoice(this.commands).then(ok => {
				if (!ok && tries++ < 5) {
					timer = mainWindow.setTimeout(read, 4000);
				}
			}, () => {
				if (tries++ < 5) {
					timer = mainWindow.setTimeout(read, 4000);
				}
			});
		};
		let timer = mainWindow.setTimeout(read, 1500);
		const onFocus = () => { tries = 0; read(); };
		mainWindow.addEventListener('focus', onFocus);
		this._register({ dispose: () => { mainWindow.clearTimeout(timer); mainWindow.removeEventListener('focus', onFocus); } });
	}
}

registerWorkbenchContribution2(DispatchAgentChoiceContribution.ID, DispatchAgentChoiceContribution, WorkbenchPhase.AfterRestored);

/**
 * How much agents may do on their own: `dispatch autonomy set` keeps it for the sessions Dispatch starts itself
 * (chatd, the phone); the window's own new sessions start with the matching approval level
 * (chat.defaultConfiguration, which a session's permission picker can still override).
 */
export async function applyAutonomy(commands: ICommandService, configuration: IConfigurationService, storage: IStorageService, level: string): Promise<IAutonomy> {
	const answer = await commands.executeCommand<(IAutonomy & { ok?: boolean; message?: string }) | undefined>('dispatch.firstRun', 'autonomy-set', { level });
	if (!answer || answer.ok === false) {
		throw new Error(answer?.message || 'Dispatch could not save that.');
	}
	const current = configuration.getValue<Record<string, unknown>>('chat.defaultConfiguration');
	await configuration.updateValue('chat.defaultConfiguration', { mode: 'interactive', ...(current && typeof current === 'object' ? current : {}), approvals: answer.ide_approvals }, ConfigurationTarget.USER);
	// the approvals picked in earlier sessions would win over the new answer: forget them
	const remembered = storage.getObject<Record<string, unknown>>(REMEMBERED_SESSION_CONFIG_KEY, StorageScope.PROFILE, {});
	if ('permissionMode' in remembered || 'autoApprove' in remembered) {
		const { permissionMode, autoApprove, ...rest } = remembered;
		storage.store(REMEMBERED_SESSION_CONFIG_KEY, JSON.stringify(rest), StorageScope.PROFILE, StorageTarget.USER);
	}
	return answer;
}

/**
 * The window follows the level `dispatch autonomy` holds even when nobody answered the question yet (the
 * first-run wizard went past it, or a Mac set up before it asked): Settings says Full auto, the default, so a
 * new session must not ask before every tool. Only while the window's own approvals setting is unset; an answer
 * in the wizard or Settings writes it (applyAutonomy), and a pick in a session still wins.
 */
class DispatchAutonomyDefaultContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'dispatch.contrib.autonomyDefault';

	constructor(
		@ICommandService commands: ICommandService,
		@IConfigurationService configuration: IConfigurationService,
		@ISessionsService sessionsService: ISessionsService,
		@ISessionsProvidersService providers: ISessionsProvidersService,
		@IStorageService storage: IStorageService,
	) {
		super();
		// The first new-session page of a window draws its draft with the agent's own default ("Always ask") while
		// Settings says Full auto; it was right only after a reload. Once the default is known the draft takes it,
		// unless the person picked a level in a session before (that pick is remembered and wins).
		let seeded = false;
		const seed = () => {
			if (seeded) {
				return;
			}
			seeded = true;
			const remembered = storage.getObject<Record<string, unknown>>(REMEMBERED_SESSION_CONFIG_KEY, StorageScope.PROFILE, {});
			const draft = sessionsService.activeSession.get();
			if (draft && draft.status.get() === SessionStatus.Untitled && !('permissionMode' in remembered) && !('autoApprove' in remembered)) {
				void applyContinuedApprovals(draft, providers, configuration);
			}
		};
		let tries = 0;
		let timer: number | undefined;
		const apply = async () => {
			const own = configuration.inspect<Record<string, unknown>>('chat.defaultConfiguration').userValue;
			if (own && typeof own === 'object' && typeof own.approvals === 'string') {
				seed();
				return;
			}
			try {
				const answer = await commands.executeCommand<(IAutonomy & { ok?: boolean }) | undefined>('dispatch.firstRun', 'autonomy');
				if (!answer || answer.ok === false || !answer.ide_approvals) {
					throw new Error('no answer');
				}
				const current = configuration.getValue<Record<string, unknown>>('chat.defaultConfiguration');
				await configuration.updateValue('chat.defaultConfiguration', { mode: 'interactive', ...(current && typeof current === 'object' ? current : {}), approvals: answer.ide_approvals }, ConfigurationTarget.USER);
				seed();
			} catch {
				// the bridge may still be starting
				if (tries++ < 5) {
					timer = mainWindow.setTimeout(() => void apply(), 4000);
				}
			}
		};
		timer = mainWindow.setTimeout(() => void apply(), 1500);
		this._register({ dispose: () => mainWindow.clearTimeout(timer) });
	}
}

registerWorkbenchContribution2(DispatchAutonomyDefaultContribution.ID, DispatchAutonomyDefaultContribution, WorkbenchPhase.AfterRestored);

CommandsRegistry.registerCommand('_dispatch.autonomy.apply', (accessor, level: string) => applyAutonomy(accessor.get(ICommandService), accessor.get(IConfigurationService), accessor.get(IStorageService), level));
