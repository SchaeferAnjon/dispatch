/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Settings pages of the Agents window that are Dispatch's own (kanban design/settings,
 *  direction B): Overview, Account and usage, Agents, Keys (dispatchSettingsKeys.ts), Appearance, Notifications, Keep awake, Phone, Macs,
 *  Projects, the Abilities list and the search results. Every page only reads and writes through the dispatch
 *  CLI (dispatch-bridge's commands) or VS Code's own settings; nothing is kept here.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { openCodeIcon } from '../../../../workbench/contrib/chat/browser/agentSessions/dispatchEngineIcons.js';
import { IAICustomizationItemsModel } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationItemsModel.js';
import { AICustomizationManagementSection } from '../../../../workbench/contrib/chat/common/aiCustomizationWorkspaceService.js';
import { toolCount } from './dispatchSettingsTools.js';
import { DISPATCH_MACHINES_ADD, dispatchMachines, editMachine, IDispatchMachine, refreshDispatchMachines } from '../../../../workbench/contrib/dispatchMachines/browser/dispatchMachines.js';
import { IMcpService } from '../../../../workbench/contrib/mcp/common/mcpTypes.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { getAgentChoice, getDefaultAgent, saveAgentChoice } from '../../dispatchAgents/browser/dispatchAgents.js';
import { DEFAULT_AUTONOMY, IAutonomy } from '../../dispatchAgents/browser/dispatchFirstRunModel.js';
import { agentIcon } from '../../dispatchAgents/browser/dispatchAgentIcons.js';
import { choiceAfterToggle, IAgentRow, isLastRunnable } from '../../dispatchAgents/browser/dispatchAgentsModel.js';

/** The agent switches' saves, one after another (switchAgent). */
let agentSaves: Promise<boolean> = Promise.resolve(true);
import { dispatchProjectsRegistry, IDispatchProject, refreshDispatchProjectsRegistry } from '../../sessions/browser/dispatchProjectsModel.js';
import { paintDispatchProjectLook } from '../../dispatchProjectCustom/browser/dispatchProjectLook.js';
import { dispatchProjectLook } from '../../dispatchProjectCustom/browser/dispatchProjectLookModel.js';
import { ABILITIES, matchParts, pageTitle, percent, searchSettings, SettingsPageId } from './dispatchSettingsModel.js';
import { renderNextUpSettings } from '../../dispatchCapture/browser/dispatchNextUpSettings.js';
import { renderTidySettings } from '../../dispatchNeat/browser/dispatchTidySettings.js';
import { renderNetworkPage } from '../../dispatchNet/browser/dispatchNetViews.js';
import { renderSettingsMe } from './dispatchSettingsMe.js';
import { renderGitIdentityRow } from './dispatchSettingsGitIdentity.js';
import { DISPATCH_MOTION_SETTING, MotionChoice, motionChoice, motionSettings } from '../../../../workbench/contrib/dispatchMotion/browser/dispatchMotionModel.js';
import { LEARN_MODE_SETTING, LearnMode, learnMode } from '../../dispatchLearn/common/dispatchLearnModel.js';
import { EXPLAIN_TERMS_SETTING, explainTermsOn } from '../../../../workbench/contrib/chat/common/dispatchTerms.js';
import { stateBlock } from '../../dispatchBlocks/browser/dispatchBlocks.js';
import { button, empty, freshness, groupHead, guide, icon, iconButton, meter, note, pending, problem, ring, row, rowsBlock, segmented, tag, toggle } from './dispatchSettingsDom.js';
import { settingsData } from './dispatchSettingsData.js';
import { DispatchUsageView } from '../../accountMenu/browser/dispatchUsage.js';
import { groupByPlace, projectPlace, splitPathTail } from '../../dispatchCommon/common/dispatchPaths.js';
import { setupDispatchTextHover } from '../../../../workbench/browser/dispatchHoverCard.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IMacNotifyValues, renderMacNotify } from './dispatchSettingsNotify.js';
import { DispatchSoulPage } from './dispatchSettingsSoul.js';
import { DispatchKeysPage } from './dispatchSettingsKeys.js';

const $ = DOM.$;
const ASK_MS = 45_000;

// ---- what the CLI answers --------------------------------------------------------------------------------

interface IWindow {
	readonly kind: string;
	readonly used_percent: number;
	readonly resets_at?: number | null;
	readonly resets?: string;
	readonly model?: string;
}

interface IEngineStatus {
	readonly engine: 'claude' | 'codex';
	readonly name: string;
	readonly signed_in: boolean;
	/** The engine's own word on its sign-in, as the Agents page says it ("Signed in with an API key"). */
	readonly sign_in?: string;
	readonly account?: { readonly name: string; readonly email?: string; readonly plan?: string | null } | null;
	readonly windows: readonly IWindow[];
	/** When its numbers were read from the server (s). */
	readonly usage_at?: number | null;
}

interface IAccountRow {
	readonly id: string;
	readonly engine: 'claude' | 'codex';
	readonly name: string;
	readonly email?: string;
	readonly plan?: string | null;
	readonly needs_signin?: boolean;
	readonly unsaved?: boolean;
	readonly active: boolean;
	readonly windows: readonly IWindow[];
	readonly short?: string;
	readonly usage_at?: number | null;
}

interface IEngineList {
	readonly engine: 'claude' | 'codex';
	readonly name: string;
	readonly signed_in: boolean;
	readonly sign_in?: string;
	readonly accounts: readonly IAccountRow[];
	readonly keyring?: boolean;
}

interface IPhone { readonly id: string; readonly name: string; readonly pairedAt: number; readonly lastSeen: number }
interface IMobileProblem { readonly reason: string; readonly message: string; readonly fix: string; readonly port: number }
/** `dispatch.mobile state`: phone access is off until you pair a phone; on but not running carries why (kanban task-lj06.19). */
interface IMobileState { readonly running: boolean; readonly access?: 'on' | 'off'; readonly problem?: IMobileProblem; readonly chatd: boolean; readonly name: string; readonly phones: readonly IPhone[] }

type PhoneNotifyKey = 'notify_reply' | 'notify_attention' | 'notify_done' | 'notify_needs_you';
/** The four the phone is told about, and banners on this Mac (the first-run wizard's switch). */
type NotifyKey = PhoneNotifyKey | 'notify_desktop';

interface IAnswer<T = unknown> { readonly ok?: boolean; readonly message?: string; readonly error?: string; readonly result?: T }

const PHONE_NOTIFY_KEYS: readonly PhoneNotifyKey[] = ['notify_reply', 'notify_attention', 'notify_done', 'notify_needs_you'];

type AwakeMode = 'system' | 'display' | 'off';

/** How old an answer from a server or another program may be before its page reads it again in the background. */
const FRESH_MS = { watch: 20_000, accounts: 20_000, agents: 30_000, overviewAgents: 5 * 60_000 } as const;

/** A group of Settings › Projects (dispatchPaths.ts names them; another Mac keeps its own name). */
function placeName(group: string): string {
	switch (group) {
		case 'This Mac': return localize('dispatchSettings.placeMac', "This Mac");
		case 'iCloud Drive': return localize('dispatchSettings.placeICloud', "iCloud Drive");
		case 'Not found': return localize('dispatchSettings.placeNotFound', "Not found");
		default: return group;
	}
}

/** Why a project shows no folder, or the other Mac it is on. */
function placeNote(note: string): string {
	switch (note) {
		case 'Folder missing': return localize('dispatchSettings.folderMissing', "Folder missing");
		case 'Not on this Mac': return localize('dispatchSettings.notOnThisMac', "Not on this Mac");
		case 'No folder': return localize('dispatchSettings.noFolder', "No folder");
		default: return note;
	}
}

function engineIcon(engine: string): ThemeIcon {
	return engine === 'codex' ? Codicon.openai : engine === 'opencode' ? openCodeIcon : engine === 'claude' ? Codicon.claude : agentIcon(engine);
}

function windowName(w: IWindow): string {
	if (w.kind === 'session') {
		return localize('dispatchSettings.win5h', "5-hour");
	}
	if (w.kind === 'weekly') {
		return localize('dispatchSettings.winWeek', "Weekly");
	}
	return w.model && /^[\x20-\x7e]+$/.test(w.model) ? localize('dispatchSettings.winModel', "{0} weekly", w.model) : localize('dispatchSettings.winOther', "Model weekly");
}

/** The windows that say something about now: the ones not past their reset, model ones only when near the limit. */
function liveWindows(windows: readonly IWindow[]): IWindow[] {
	const now = Date.now() / 1000;
	const order = (w: IWindow) => w.kind === 'session' ? 0 : w.kind === 'weekly' ? 1 : 2;
	return windows.filter(w => typeof w.used_percent === 'number' && !(w.resets_at && w.resets_at < now))
		.filter(w => w.kind === 'session' || w.kind === 'weekly' || percent(w.used_percent) >= 80)
		.sort((a, b) => order(a) - order(b));
}

export interface ISettingsPageHost {
	go(page: SettingsPageId, flash?: string): void;
	close(): void;
	/** Something changed the page's height after it was drawn. */
	relayout(): void;
}

export class DispatchSettingsPages {

	constructor(
		private readonly host: ISettingsPageHost,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@INotificationService private readonly notificationService: INotificationService,
		@IPathService private readonly pathService: IPathService,
		@IAICustomizationItemsModel private readonly itemsModel: IAICustomizationItemsModel,
		@IMcpService private readonly mcpService: IMcpService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IHoverService private readonly hoverService: IHoverService,
	) { }

	private async ask<T>(command: string, ...args: unknown[]): Promise<T | undefined> {
		try {
			return await raceTimeout(this.commandService.executeCommand<T>(command, ...args), ASK_MS);
		} catch {
			return undefined;
		}
	}

	private alive(root: HTMLElement, store: DisposableStore): boolean {
		return root.isConnected && !store.isDisposed;
	}

	render(page: SettingsPageId, root: HTMLElement, store: DisposableStore, query: string): void {
		if (query.trim()) {
			this.results(root, store, query);
			return;
		}
		switch (page) {
			case 'overview': return this.overview(root, store);
			case 'account': return this.account(root, store);
			case 'usage': return this.usage(root, store);
			case 'agents': return this.agents(root, store);
			case 'soul': return this.instantiationService.createInstance(DispatchSoulPage, { relayout: () => this.host.relayout(), alive: (r: HTMLElement, s: DisposableStore) => this.alive(r, s), go: page => this.host.go(page) }).render(root, store);
			case 'keys': return this.instantiationService.createInstance(DispatchKeysPage, { relayout: () => this.host.relayout(), alive: (r: HTMLElement, s: DisposableStore) => this.alive(r, s) }).render(root, store);
			case 'appearance': return this.appearance(root, store);
			case 'learning': return this.learning(root, store);
			case 'notifications': return this.notifications(root, store);
			case 'awake': return this.awake(root, store);
			case 'network': return renderNetworkPage(root, store, { commandService: this.commandService, quickInputService: this.quickInputService, notificationService: this.notificationService, choiceRows: this.choiceRows.bind(this), alive: (r, s) => this.alive(r, s), relayout: () => this.host.relayout() });
			case 'phone': return this.phone(root, store);
			case 'macs': return this.macs(root, store);
			case 'projects': return this.projects(root, store);
			case 'abilities': return this.abilities(root, store);
		}
	}

	/** The line under the page's name. */
	static lede(page: SettingsPageId): string | undefined {
		switch (page) {
			case 'overview': return localize('dispatchSettings.ledeOverview', "Settings for Dispatch on this Mac. The editor window keeps its own settings.");
			case 'account': return localize('dispatchSettings.ledeAccount', "The accounts your agents run on, and how much of each allowance is used.");
			case 'usage': return localize('dispatchSettings.ledeUsage', "Allowance, tokens, money and tools of every agent on this Mac.");
			case 'agents': return localize('dispatchSettings.ledeAgents', "The coding agents Dispatch starts sessions with.");
			case 'soul': return localize('dispatchSettings.ledeSoul', "Everything Dispatch gives every agent, in one place. Soul, how they talk and work, is yours to change; the rest comes with Dispatch.");
			case 'keys': return localize('dispatchSettings.ledeKeys', "API keys and other secrets your agents use. Save one here once; every agent uses it by its name, and the value never goes into a chat.");
			case 'appearance': return localize('dispatchSettings.ledeAppearance', "How Dispatch looks. Changes show at once.");
			case 'learning': return localize('dispatchSettings.ledeLearning', "Dispatch is also a place to learn what your agents do. Select anything and choose Ask Question; the answer comes in a side chat.");
			case 'notifications': return localize('dispatchSettings.ledeNotify', "When Dispatch tells you something happened.");
			case 'awake': return localize('dispatchSettings.ledeAwakeWork', "Agents stop when this Mac goes to sleep. Dispatch keeps it awake while an agent is working or your phone is connected.");
			case 'network': return localize('dispatchSettings.ledeNetwork', "How the agents reach their servers from this Mac: the proxy they use, where downloads come from, and models that work from China.");
			case 'phone': return localize('dispatchSettings.ledePhone', "Your phone talks to this Mac directly. Nothing goes through a Dispatch server.");
			case 'macs': return localize('dispatchSettings.ledeMacs', "Your Macs. Each one opens in its own window with its own sessions.");
			case 'projects': return localize('dispatchSettings.ledeProjects', "The folders Dispatch knows. The name only changes in Dispatch; the folder stays as it is.");
			case 'abilities': return localize('dispatchSettings.ledeAbilities', "What agents can use besides your words: skills, tools, rules and what they know. Most people never need to change these.");
			case 'agent:claude': return localize('dispatchSettings.ledeClaude', "Claude Code's own settings, the same for every Claude session.");
			case 'agent:codex': return localize('dispatchSettings.ledeCodex', "Codex's own settings, the same for every Codex session.");
			case 'agent:opencode': return localize('dispatchSettings.ledeOpenCode', "OpenCode's own settings and the AI services it uses.");
			default: return undefined;
		}
	}

	// ---- Overview --------------------------------------------------------------------------------------------

	private overview(root: HTMLElement, store: DisposableStore): void {
		void refreshDispatchMachines(this.commandService, true);
		// Dispatch IDE: you first, your GitHub picture and name (dispatchSettingsMe.ts)
		renderSettingsMe(root, store, this.commandService);

		const tiles = DOM.append(root, $('.dset-tiles'));
		const tile = (page: SettingsPageId, label: string, ic: ThemeIcon, flash?: string): { body: HTMLElement; sub: HTMLElement; value: HTMLElement } => {
			const t = DOM.append(tiles, $('button.dset-tile'));
			t.dataset.page = page;
			const h = DOM.append(t, $('.dset-tile-h'));
			h.appendChild(icon(ic));
			DOM.append(h, $('span', undefined, label));
			h.appendChild(icon(Codicon.chevronRight, 'dset-go'));
			const body = DOM.append(t, $('.dset-tile-v'));
			const value = DOM.append(body, $('span.dset-tile-val'));
			const sub = DOM.append(t, $('.dset-tile-s'));
			store.add(DOM.addDisposableListener(t, DOM.EventType.CLICK, () => this.host.go(page, flash)));
			return { body, sub, value };
		};

		// usage of the accounts in use: the last numbers at once, read again in the background
		void settingsData.refresh('watch', FRESH_MS.watch);
		const engines = settingsData.get<readonly IEngineStatus[]>('watch');
		for (const engine of ['claude', 'codex'] as const) {
			const t = tile('account', engine === 'claude' ? localize('dispatchSettings.tileClaude', "Claude") : localize('dispatchSettings.tileCodex', "Codex"), engineIcon(engine), 'accounts');
			const e = engines?.find(x => x.engine === engine);
			const live = e ? liveWindows(e.windows) : [];
			const five = live.find(w => w.kind === 'session');
			const week = live.find(w => w.kind === 'weekly');
			DOM.clearNode(t.body);
			if (!engines) {
				// never read on this Mac yet: the first answer draws it
				freshness(t.sub, 'watch', store);
				continue;
			}
			if (!e || !e.signed_in) {
				DOM.append(t.body, $('span.dset-tile-val', undefined, localize('dispatchSettings.notSignedIn', "Not signed in")));
				t.sub.textContent = localize('dispatchSettings.signInThere', "Sign in on Account and usage");
				continue;
			}
			const main = five ?? week;
			if (main) {
				ring(t.body, percent(main.used_percent));
			}
			// signed in without a saved account (an API key, say): the engine's own words, as on the Agents page
			DOM.append(t.body, $('span.dset-tile-val', undefined, main
				? (main === five ? localize('dispatchSettings.of5hUsed', "{0}% of 5 hours used", percent(main.used_percent)) : localize('dispatchSettings.ofWeekUsed', "{0}% of the week used", percent(main.used_percent)))
				: !e.account && e.sign_in ? e.sign_in : localize('dispatchSettings.noNumbers', "No usage numbers yet")));
			t.sub.textContent = [main?.resets ? localize('dispatchSettings.resets', "resets {0}", main.resets) : '', main === five && week ? localize('dispatchSettings.weekUsed', "week {0}% used", percent(week.used_percent)) : ''].filter(Boolean).join(' · ');
			if (main) {
				// the numbers are as old as their last reading, which the answer says
				if (t.sub.textContent) {
					t.sub.append(' · ');
				}
				freshness(t.sub, 'watch', store, () => e.usage_at ? e.usage_at * 1000 : undefined);
			}
		}

		const agentsTile = tile('agents', localize('dispatchSettings.tileAgents', "Agents"), Codicon.hubot);
		void settingsData.refresh('agents', FRESH_MS.overviewAgents);
		const rows = settingsData.get<readonly IAgentRow[]>('agents');
		if (rows) {
			DOM.clearNode(agentsTile.body);
			const on = rows.filter(a => a.runnable && a.installed && a.enabled);
			for (const a of on) {
				const b = DOM.append(agentsTile.body, $('span.dset-brand.sm', { title: a.name }));
				b.classList.toggle('def', a.is_default);
				b.appendChild(icon(engineIcon(a.id)));
			}
			const def = on.find(a => a.is_default);
			agentsTile.sub.textContent = def ? localize('dispatchSettings.startsNew', "{0} starts new sessions", def.name) : '';
		} else {
			freshness(agentsTile.sub, 'agents', store);
		}

		const awakeTile = tile('awake', localize('dispatchSettings.tileAwake', "Keep awake"), Codicon.coffee);
		const mode = this.awakeMode();
		DOM.clearNode(awakeTile.body);
		this.cup(awakeTile.body, mode !== 'off', true);
		DOM.append(awakeTile.body, $('span.dset-tile-val', undefined, mode === 'off' ? localize('dispatchSettings.sleepsAsUsual', "Sleeps as usual") : localize('dispatchSettings.awakeWhileWork', "Awake while agents work")));
		awakeTile.sub.textContent = mode === 'display' ? localize('dispatchSettings.screenOnToo', "The screen stays on too") : mode === 'off' ? localize('dispatchSettings.agentsStopSleep', "Agents stop when the Mac sleeps") : localize('dispatchSettings.screenSleeps', "The screen still sleeps");

		const notifyTile = tile('notifications', localize('dispatchSettings.tileNotify', "Notifications"), Codicon.bell);
		const ns = settingsData.get<Record<NotifyKey, boolean> & IMacNotifyValues>('notify');
		if (ns) {
			const on = PHONE_NOTIFY_KEYS.filter(k => ns[k]).length;
			const anyKind = ns.notify_mac_finished !== false || ns.notify_mac_needs_you !== false || ns.notify_mac_stopped === true;
			notifyTile.value.textContent = anyKind ? localize('dispatchSettings.bannersOn', "Banners on this Mac") : localize('dispatchSettings.bannersOff', "No banners on this Mac");
			notifyTile.sub.textContent = localize('dispatchSettings.notifyPhone', "{0} of 4 go to your phone once one is paired", on);
		}

		const phoneTile = tile('phone', localize('dispatchSettings.tilePhone', "Phone"), Codicon.deviceMobile);
		const ms = settingsData.get<IMobileState>('mobile');
		if (ms) {
			const n = ms.phones.length;
			phoneTile.value.textContent = n ? (n === 1 ? localize('dispatchSettings.onePhone', "{0} is paired", ms.phones[0].name) : localize('dispatchSettings.nPhones', "{0} phones paired", n)) : localize('dispatchSettings.noPhoneYet', "No phone yet");
			phoneTile.sub.textContent = ms.running && ms.access !== 'off' && !ms.problem ? localize('dispatchSettings.phoneAccessOn', "Phone access is on") : ms.access === 'on' && ms.problem && ms.problem.reason !== 'starting' ? localize('dispatchSettings.phoneNotWorking', "Phone access is not working") : localize('dispatchSettings.pairToReply', "Pair one to reply from anywhere");
		}

		const macsTile = tile('macs', localize('dispatchSettings.tileMacs', "Macs"), Codicon.vm);
		store.add(autorun(reader => {
			const list = dispatchMachines.read(reader);
			if (!list) {
				return;
			}
			const local = list.find(m => m.local);
			macsTile.value.textContent = local?.name ?? localize('dispatchSettings.thisMac2', "This Mac");
			const others = list.filter(m => !m.local).length;
			macsTile.sub.textContent = others ? (others === 1 ? localize('dispatchSettings.oneMore', "1 more Mac") : localize('dispatchSettings.nMore', "{0} more Macs", others)) : localize('dispatchSettings.onlyThis', "Only this Mac so far");
		}));

		const lookTile = tile('appearance', localize('dispatchSettings.tileLook', "Appearance"), Codicon.colorMode);
		const theme = this.themeMode();
		lookTile.value.textContent = theme === 'system' ? localize('dispatchSettings.sys', "System") : theme === 'light' ? localize('dispatchSettings.light', "Light") : localize('dispatchSettings.dark', "Dark");
		lookTile.sub.textContent = this.motionLabel();

		// projects
		groupHead(root, localize('dispatchSettings.projects', "Projects"), Codicon.folder);
		const strip = DOM.append(root, $('button.dset-strip'));
		store.add(DOM.addDisposableListener(strip, DOM.EventType.CLICK, () => this.host.go('projects')));
		void refreshDispatchProjectsRegistry();
		store.add(autorun(reader => {
			const all = dispatchProjectsRegistry.read(reader);
			DOM.clearNode(strip);
			const shown = (all ?? []).filter(p => !p.archived);
			for (const p of shown.slice(0, 6)) {
				const s = DOM.append(strip, $('span'));
				s.appendChild(icon(Codicon.folder));
				DOM.append(s, $('span', undefined, p.label || p.name));
			}
			const end = DOM.append(strip, $('span.dset-strip-end', undefined, all ? (shown.length === 1 ? localize('dispatchSettings.oneProject', "1 project") : localize('dispatchSettings.nProjects', "{0} projects", shown.length)) : ''));
			end.appendChild(icon(Codicon.chevronRight));
		}));

		// advanced
		groupHead(root, localize('dispatchSettings.advanced', "Advanced"), Codicon.tools);
		const adv = DOM.append(root, $('button.dset-strip'));
		store.add(DOM.addDisposableListener(adv, DOM.EventType.CLICK, () => this.host.go('abilities')));
		store.add(autorun(reader => {
			DOM.clearNode(adv);
			DOM.append(adv, $('span.dset-strip-name', undefined, localize('dispatchSettings.abilities', "Abilities")));
			const counts: [number, string][] = [
				[this.itemsModel.getCount(AICustomizationManagementSection.Skills).read(reader), localize('dispatchSettings.cSkills', "skills")],
				[toolCount(this.mcpService.servers.read(reader).length, reader), localize('dispatchSettings.cTools', "tools")],
				[this.itemsModel.getPluginCount().read(reader), localize('dispatchSettings.cPlugins', "plugins")],
				[this.itemsModel.getCount(AICustomizationManagementSection.Hooks).read(reader), localize('dispatchSettings.cHooks', "hooks")],
				[this.itemsModel.getCount(AICustomizationManagementSection.Agents).read(reader), localize('dispatchSettings.cSubagents', "sub-agents")],
			];
			for (const [n, what] of counts) {
				const s = DOM.append(adv, $('span'));
				DOM.append(s, $('b', undefined, String(n)));
				s.append(` ${what}`);
			}
			const end = DOM.append(adv, $('span.dset-strip-end'));
			end.appendChild(icon(Codicon.chevronRight));
		}));
	}

	// ---- Account and usage -------------------------------------------------------------------------------------

	private account(root: HTMLElement, store: DisposableStore): void {
		const body = DOM.append(root, $('.dset-section'));
		body.dataset.setting = 'accounts';
		const err = DOM.append(root, $('.dset-problem', { role: 'alert' }));
		err.hidden = true;
		const show = (message: string) => { err.textContent = message; err.hidden = !message; this.host.relayout(); };
		// a change here: both readings again (this page and the Overview's tiles); the page follows the answer
		const again = async () => { await Promise.all([settingsData.refresh('accounts'), settingsData.refresh('watch')]); };
		const reading = settingsData.refresh('accounts', FRESH_MS.accounts);
		const list = settingsData.get<IEngineList[]>('accounts');
		if (!list) {
			const wait = pending(body, localize('dispatchSettings.readingAccounts', "Reading your accounts for the first time"));
			void reading.then(() => {
				if (this.alive(root, store) && !settingsData.get('accounts')) {
					wait.remove();
					show(localize('dispatchSettings.accountsFailed', "Dispatch could not read your accounts just now."));
				}
			});
		}
		for (const e of list ?? []) {
			const head = groupHead(body, e.name, engineIcon(e.engine));
			freshness(DOM.append(head, $('span.dset-gh-r')), 'accounts', store, () => {
				const at = e.accounts.find(a => a.active)?.usage_at;
				return at ? at * 1000 : undefined;
			});
			const block = rowsBlock(body);
			if (e.keyring) {
				row(block, { label: localize('dispatchSettings.keyring', "Its sign-in is in the macOS keychain"), detail: localize('dispatchSettings.keyringDetail', "Dispatch cannot switch this one. Sign in to Codex with a file instead to keep several accounts.") }, store);
				continue;
			}
			for (const a of e.accounts) {
				this.accountRow(block, a, store, show, again);
			}
			if (!e.accounts.length && e.signed_in) {
				// signed in the engine's own way with nothing Dispatch can switch (an API key): say so, as the Agents page does
				const apiKey = /api key/i.test(e.sign_in ?? '');
				const r = row(block, {
					label: e.sign_in || localize('dispatchSettings.signedIn', "Signed in"),
					detail: apiKey ? localize('dispatchSettings.apiKeyDetail', "An API key is billed by use, so there is no allowance to show here.") : undefined,
					icon: engineIcon(e.engine),
					brand: true,
				}, store);
				r.row.dataset.signIn = e.engine;
				tag(r.ctl, localize('dispatchSettings.inUse', "In use"), 'solid');
			}
			const add = DOM.append(block, $('button.dset-addrow'));
			add.appendChild(icon(Codicon.add));
			DOM.append(add, $('span', undefined, e.accounts.length || e.signed_in
				? localize('dispatchSettings.addAccount', "Add a {0} account…", e.name)
				: localize('dispatchSettings.signIn', "Sign in to {0}…", e.name)));
			store.add(DOM.addDisposableListener(add, DOM.EventType.CLICK, () => {
				show('');
				// the engine's own sign-in runs in a terminal; the account in use stays signed in meanwhile
				void this.ask('dispatch.accounts', 'add', e.engine, !e.accounts.length).then(again);
			}));
		}

		groupHead(root, localize('dispatchSettings.usage', "Usage"), Codicon.graph);
		DOM.append(root, $('.dset-anchor')).dataset.setting = 'usage';
		guide(root, Codicon.graph, localize('dispatchSettings.usageGuide', "Every account's allowance, what your agents cost, and the tools they use."), localize('dispatchSettings.openUsage', "Open Usage"), () => {
			this.host.go('usage');
		}, store);
		groupHead(root, localize('dispatchSettings.opencodeServices', "OpenCode"), openCodeIcon);
		guide(root, openCodeIcon, localize('dispatchSettings.opencodeGuide', "OpenCode runs on AI services you connect, each with its own allowance."), localize('dispatchSettings.openOpenCode', "OpenCode"), () => this.host.go('agent:opencode'), store);
	}

	// ---- Usage (Account and usage › Usage) ------------------------------------------------------------------------

	/** The Usage page's contents (accountMenu/dispatchUsage.ts) inside Settings: the window stays in Settings. */
	private usage(root: HTMLElement, store: DisposableStore): void {
		const view = store.add(this.instantiationService.createInstance(DispatchUsageView));
		view.render(DOM.append(root, $('.dset-usage')));
		this.host.relayout();
	}

	private accountRow(block: HTMLElement, a: IAccountRow, store: DisposableStore, show: (m: string) => void, again: () => Promise<void>): void {
		const r = row(block, {
			label: a.name,
			detail: a.email && a.email !== a.name ? a.email : undefined,
			icon: engineIcon(a.engine),
			brand: true,
		}, store);
		r.row.dataset.account = a.id;
		if (a.plan) {
			tag(r.label, a.plan.charAt(0).toUpperCase() + a.plan.slice(1));
		}
		if (a.active) {
			tag(r.ctl, a.unsaved ? localize('dispatchSettings.inUseUnsaved', "In use, not saved yet") : localize('dispatchSettings.inUse', "In use"), 'solid');
			const wins = liveWindows(a.windows);
			const meters = DOM.append(block, $('.dset-meters'));
			if (!wins.length) {
				DOM.append(meters, $('.dset-row-detail', undefined, localize('dispatchSettings.noUsage', "No usage numbers yet.")));
			}
			for (const w of wins) {
				meter(meters, windowName(w), percent(w.used_percent), w.resets ? localize('dispatchSettings.resetsAt', "resets {0}", w.resets) : '');
			}
			return;
		}
		const top = liveWindows(a.windows).sort((x, y) => percent(y.used_percent) - percent(x.used_percent))[0];
		DOM.append(r.ctl, $('span.dset-quiet', undefined, top ? localize('dispatchSettings.used', "{0}% used", percent(top.used_percent)) : (a.short || '')));
		if (a.needs_signin) {
			button(r.ctl, localize('dispatchSettings.signInAgain', "Sign in again"), () => this.ask('dispatch.accounts', 'add', a.engine, false).then(again), store);
		} else {
			const use = button(r.ctl, localize('dispatchSettings.useThis', "Use this one"), async () => {
				use.enabled = false;
				show('');
				const ans = await this.ask<IAnswer>('dispatch.accounts', 'use', a.engine, a.id);
				if (!ans || ans.ok === false) {
					show(ans?.message || localize('dispatchSettings.useFailed', "Dispatch could not switch accounts just now."));
					use.enabled = true;
					return;
				}
				await again();
			}, store);
			use.setTitle(localize('dispatchSettings.useTitle', "Sessions in Dispatch move to {0} with their next message.", a.name));
		}
		iconButton(r.ctl, Codicon.trash, localize('dispatchSettings.remove', "Remove {0} from this Mac", a.name), async () => {
			const { confirmed } = await this.dialogService.confirm({
				message: localize('dispatchSettings.removeConfirm', "Remove {0} from this Mac?", a.name),
				detail: localize('dispatchSettings.removeDetail', "Dispatch forgets this account and its sign-in. To use it again, sign in to it again."),
				primaryButton: localize({ key: 'dispatchSettings.removeButton', comment: ['&& denotes a mnemonic'] }, "&&Remove"),
			});
			if (!confirmed) {
				return;
			}
			const ans = await this.ask<IAnswer>('dispatch.accounts', 'remove', a.engine, a.id);
			if (!ans || ans.ok === false) {
				show(ans?.message || localize('dispatchSettings.removeFailed', "Dispatch could not remove the account just now."));
				return;
			}
			await again();
		}, store);
	}

	// ---- Agents -------------------------------------------------------------------------------------------------

	private agents(root: HTMLElement, store: DisposableStore): void {
		const body = DOM.append(root, $('.dset-section'));
		// the agents on this Mac and their versions come from running them: the last answer now, read again meanwhile
		const reading = settingsData.refresh('agents', FRESH_MS.agents);
		const rows = settingsData.get<readonly IAgentRow[]>('agents');
		const head = groupHead(body, localize('dispatchSettings.agentsYouUse', "Agents you use"), Codicon.hubot);
		freshness(DOM.append(head, $('span.dset-gh-r')), 'agents', store);
		if (!rows) {
			const wait = pending(body, localize('dispatchSettings.lookingForAgents', "Looking for agents on this Mac for the first time"));
			void reading.then(() => {
				if (this.alive(root, store) && !settingsData.get('agents')) {
					wait.remove();
					problem(body, localize('dispatchSettings.agentsFailed', "Dispatch could not look for agents just now."));
					button(body, localize('dispatchSettings.retry', "Try again"), () => void settingsData.refresh('agents'), store);
					this.host.relayout();
				}
			});
		} else {
			this.agentList(body, rows, root, store);
		}
		this.autonomy(body, store);
		this.otherApps(body, store);
		this.whereAgentsWork(body, store);
		this.commitLine(body, store);
		const usable = (rows ?? []).filter(a => a.runnable && a.installed && a.enabled);
		renderNextUpSettings(body, store, this.commandService, this.notificationService, usable, () => this.host.relayout());
		renderTidySettings(body, store, this.commandService, this.notificationService, usable, () => this.host.relayout());

		const others = (rows ?? []).filter(a => !a.runnable && a.installed);
		if (others.length) {
			groupHead(body, localize('dispatchSettings.alsoHere', "Also on this Mac, opened in the terminal"), Codicon.terminal);
			// where to start one, as it is (the new session page has no such button, task-tt6y)
			DOM.append(body, $('.dset-sub', undefined, localize('dispatchSettings.alsoHereDetail2', "Dispatch cannot hold a conversation with these yet. Open one in a terminal: press ⌘T, or point at a project in the sessions list and choose New Terminal… from the arrow next to its +.")));
			const more = rowsBlock(body, 'terminal-agents');
			for (const a of others) {
				row(more, { label: a.name, detail: [a.version, a.about].filter(Boolean).join(' · '), icon: agentIcon(a.id), brand: true }, store);
			}
			const openLine = DOM.append(body, $('.dset-actions'));
			button(openLine, localize('dispatchSettings.openTerminal', "Open a Terminal"), () => this.commandService.executeCommand('dispatch.terminal.open'), store);
		}
		const scanLine = DOM.append(body, $('.dset-actions'));
		button(scanLine, localize('dispatchSettings.scan', "Look again"), () => void settingsData.refresh('agents'), store);
	}

	/** The agents Dispatch starts sessions with, each with its switch. */
	private agentList(body: HTMLElement, rows: readonly IAgentRow[], root: HTMLElement, store: DisposableStore): void {
		const ours = rows.filter(a => a.runnable);
		// the switches as they are now: a second switch flipped before the page is drawn again (it asks the CLI
		// first) works from these, not from the rows the page was drawn with (10-07: turning off three in a row
		// turned the first two back on and passed the keep-one check)
		let current = rows;
		const block = rowsBlock(body, 'agents');
		for (const a of ours) {
			const r = row(block, {
				label: a.name,
				detail: a.installed ? [a.version, a.account].filter(Boolean).join(' · ') || a.about : localize('dispatchSettings.notInstalled', "Not on this Mac yet. Installing adds it so Dispatch can start sessions with it."),
				icon: engineIcon(a.id),
				brand: true,
				onClick: a.installed ? () => this.host.go(`agent:${a.id}` as SettingsPageId) : undefined,
			}, store);
			r.row.dataset.agent = a.id;
			if (!a.installed) {
				const install = button(r.ctl, localize('dispatchSettings.install', "Install"), async () => {
					install.enabled = false;
					install.label = localize('dispatchSettings.installing', "Installing…");
					try {
						// a failed install says why (kanban task-jvtg): the answer was dropped and the row just came back
						const answer = await this.commandService.executeCommand<{ ok?: boolean; message?: string; command?: string }>('dispatch.engines', 'upgrade', a.id);
						if (!answer?.ok) {
							throw new Error([answer?.message || localize('dispatchSettings.noAnswer', "Dispatch did not answer."), answer?.command ? localize('dispatchSettings.orRun', "You can also run {0} in a terminal.", answer.command) : ''].filter(Boolean).join(' '));
						}
					} catch (e) {
						this.notificationService.warn(localize('dispatchSettings.installFailed', "Could not install {0}: {1}", a.name, String((e as Error)?.message ?? e)));
					}
					await settingsData.refresh('agents');
					if (this.alive(root, store)) {
						install.enabled = true;
						install.label = localize('dispatchSettings.install', "Install");
					}
				}, store);
				continue;
			}
			const on = a.enabled;
			if (on) {
				if (a.is_default) {
					tag(r.label, localize('dispatchSettings.default', "Default"));
				} else {
					const set = button(r.ctl, localize('dispatchSettings.makeDefault', "Make default"), async () => {
						set.enabled = false;
						try {
							await saveAgentChoice(this.commandService, { default: a.id });
							settingsData.set('agents', current.map(x => ({ ...x, is_default: x.id === a.id })));
							void settingsData.refresh('agents');
						} catch (e) {
							this.notificationService.warn(String((e as Error)?.message ?? e));
							set.enabled = true;
						}
					}, store);
					set.setTitle(localize('dispatchSettings.makeDefaultTitle', "New sessions start with {0}", a.name));
				}
			}
			toggle(r.ctl, localize('dispatchSettings.useAgent', "Use {0} with Dispatch", a.name), on, want => agentSaves = agentSaves.then(() => this.switchAgent(a.id, want, () => current, rows, now => { current = now; })), store);
		}
		this.agentsFoot(body, rows);
	}

	/** One agent switched on or off in Settings › Agents. Switches save one after another (agentSaves), each from the
	 *  newest choice (the last save's answer, else what the page was drawn with), so a second switch flipped before the
	 *  page is drawn again keeps the first one's change (10-07: three in a row turned the first two back on). */
	private async switchAgent(id: string, want: boolean, drawn: () => readonly IAgentRow[], rows: readonly IAgentRow[], keep: (now: readonly IAgentRow[]) => void): Promise<boolean> {
		const choice = getAgentChoice();
		const now = choice ? rows.map(x => ({ ...x, enabled: x.runnable ? !choice.off.includes(x.id) : choice.on.includes(x.id) })) : drawn();
		if (!want && isLastRunnable(now, id)) {
			this.notificationService.info(localize('dispatchSettings.keepOne', "Keep at least one agent on: Dispatch needs one to start a session."));
			return false;
		}
		try {
			await saveAgentChoice(this.commandService, choiceAfterToggle(now, id, want));
			const after = now.map(x => x.id === id ? { ...x, enabled: want } : x);
			keep(after);
			// the page follows at once; which one is the default now comes with the next reading
			settingsData.set('agents', after);
			void settingsData.refresh('agents');
			return true;
		} catch (e) {
			this.notificationService.warn(String((e as Error)?.message ?? e));
			return false;
		}
	}

	private agentsFoot(body: HTMLElement, rows: readonly IAgentRow[]): void {
		DOM.append(body, $('.dset-foot', undefined, localize('dispatchSettings.offHidden', "An agent that is off does not show up when you start a new session. {0} is the default now.", rows.find(a => a.is_default)?.name ?? getDefaultAgent())));
	}

	/** How much agents may do on their own: the first-run question again, the same three and the same value
	 *  (kanban app/cli/autonomy.py through dispatch-bridge's `dispatch.firstRun`), applied the way the wizard and
	 *  Customizations apply it (`_dispatch.autonomy.apply`). */
	private autonomy(body: HTMLElement, store: DisposableStore): void {
		groupHead(body, localize('dispatchSettings.onTheirOwn', "What agents may do on their own"), Codicon.shield);
		const slot = DOM.append(body, $('.dset-section'));
		const a = settingsData.get<IAutonomy & { ok?: boolean }>('autonomy');
		if (!a) {
			pending(slot);
			return;
		}
		if (!Array.isArray(a.levels) || !a.levels.length) {
			problem(slot, localize('dispatchSettings.autonomyFailed', "Dispatch could not read this just now."));
			return;
		}
		const choices = a.levels.map(l => [l.id, l.title, l.detail] as [string, string, string]);
		this.choiceRows(slot, 'autonomy', choices, a.level || DEFAULT_AUTONOMY, async id => {
			try {
				await this.commandService.executeCommand('_dispatch.autonomy.apply', id);
				settingsData.set('autonomy', { ...a, level: id });
				return true;
			} catch (e) {
				this.notificationService.warn(localize('dispatchSettings.autonomySaveFailed', "Could not change this: {0}", String((e as Error)?.message ?? e)));
				return false;
			}
		}, store, DEFAULT_AUTONOMY);
		DOM.append(slot, $('.dset-foot', undefined, localize('dispatchSettings.autonomyFoot', "This is what new sessions start with. Each session can still be changed from its message box.")));
	}

	/** Other apps on this Mac without asking each time (kanban app/cli/computer.py `allowed --all`; memo 2026-10-19:
	 *  "agree once and it can work on its own, or the work stops while I am away"). */
	private otherApps(body: HTMLElement, store: DisposableStore): void {
		const block = rowsBlock(body, 'computer-all');
		const r = row(block, {
			label: localize('dispatchSettings.computerAll', "Use other apps without asking"),
			detail: localize('dispatchSettings.computerAllDetail', "Off: an agent asks before it uses an app (Notes, Finder, the Simulator…), and Always Allow there skips the question for that app. On: no question for any app. Terminals, code editors, Dispatch itself, System Settings and password apps stay off limits, and the bar at the top of the screen still shows every step with Stop."),
		}, store);
		const c = settingsData.get<{ ok?: boolean; all?: boolean }>('computer');
		if (c?.ok) {
			toggle(r.ctl, localize('dispatchSettings.computerAll', "Use other apps without asking"), !!c.all, async want => {
				const done = await this.ask<{ ok?: boolean; all?: boolean; apps?: string[] }>('dispatch.computerAllowAll', want);
				const ok = !!done?.ok && done.all === want;
				if (ok) {
					settingsData.set('computer', done);
				}
				return ok;
			}, store);
		}
	}

	/** Where a new session's agent makes its changes: `sessions.useWorktree` (kanban task-lj06.16; off by default, product.json). */
	private whereAgentsWork(body: HTMLElement, store: DisposableStore): void {
		groupHead(body, localize('dispatchSettings.whereWork', "Where agents make their changes"), Codicon.folder);
		const slot = DOM.append(body, $('.dset-section'));
		const current = this.configurationService.getValue<boolean>('sessions.useWorktree') === true ? 'copy' : 'folder';
		const choices: [string, string, string][] = [
			['folder', localize('dispatchSettings.workInFolder', "In the project folder"), localize('dispatchSettings.workInFolderDetail', "When an agent says it is done, its changes are in your folder. While another agent works in the same folder, it uses a separate copy and puts its changes back by itself, asking you only when both changed the same lines.")],
			['copy', localize('dispatchSettings.workInCopy', "In a separate copy"), localize('dispatchSettings.workInCopyDetail', "Your folder stays as it is until you press Merge Changes at the top of a session.")],
		];
		this.choiceRows(slot, 'where-work', choices, current, async id => {
			await this.configurationService.updateValue('sessions.useWorktree', id === 'copy', ConfigurationTarget.USER);
			return true;
		}, store, 'folder');
		DOM.append(slot, $('.dset-foot', undefined, localize('dispatchSettings.whereWorkFoot', "This is what new sessions start with. Each session can still be changed with Separate copy under its message box.")));
	}

	/** Commits: whether agents name themselves in commit messages (kanban app/cli/attribution.py `config`). */
	private commitLine(root: HTMLElement, store: DisposableStore): void {
		groupHead(root, localize('dispatchSettings.commits', "Commits"), Codicon.gitCommit);
		const block = rowsBlock(root, 'co-author');
		// whose name the commits carry, asked once instead of made up (dispatchSettingsGitIdentity.ts, task-pog4t)
		renderGitIdentityRow(block, store, { commandService: this.commandService, quickInputService: this.quickInputService, notificationService: this.notificationService, relayout: () => this.host.relayout() });
		const r = row(block, {
			label: localize('dispatchSettings.coAuthor', "Sign commits as co-authored by the AI"),
			detail: localize('dispatchSettings.coAuthorDetail', "Off: commit messages stay as the agent writes them, and Dispatch adds nothing. On: each turn asks the agent to end its commit messages with a Co-authored-by line naming itself, so GitHub shows it next to you. Who wrote which line stays in Dispatch on this Mac either way."),
		}, store);
		const c = settingsData.get<{ ok?: boolean; co_author?: boolean }>('attribution');
		if (c?.ok) {
			toggle(r.ctl, localize('dispatchSettings.coAuthor', "Sign commits as co-authored by the AI"), !!c.co_author, async want => {
				const done = await this.ask<{ ok?: boolean; co_author?: boolean }>('dispatch.attributionConfig', want);
				const ok = !!done?.ok && done.co_author === want;
				if (ok) {
					settingsData.set('attribution', done);
				}
				return ok;
			}, store);
		}
	}

	// ---- Appearance ---------------------------------------------------------------------------------------------

	private themeMode(): 'system' | 'light' | 'dark' {
		if (this.configurationService.getValue<boolean>('window.autoDetectColorScheme')) {
			return 'system';
		}
		return this.configurationService.getValue<string>('workbench.colorTheme') === 'Dispatch Light' ? 'light' : 'dark';
	}

	private motionNow(): MotionChoice {
		return motionChoice(this.configurationService.getValue<string>('workbench.reduceMotion'), this.configurationService.getValue<string>(DISPATCH_MOTION_SETTING));
	}

	private motionLabel(): string {
		switch (this.motionNow()) {
			case 'none': return localize('dispatchSettings.motionNone', "No motion");
			case 'full': return localize('dispatchSettings.motionFull', "Full motion");
			case 'less': return localize('dispatchSettings.motionLess', "Less motion");
			default: return localize('dispatchSettings.motionMac', "Motion as on your Mac");
		}
	}

	private appearance(root: HTMLElement, store: DisposableStore): void {
		groupHead(root, localize('dispatchSettings.lightOrDark', "Light or dark"), Codicon.colorMode);
		const block = rowsBlock(root, 'theme');
		block.classList.add('dset-pad');
		const themes = DOM.append(block, $('.dset-themes', { role: 'radiogroup', 'aria-label': localize('dispatchSettings.lightOrDark2', "Light or dark") }));
		const current = this.themeMode();
		const options: { id: 'system' | 'light' | 'dark'; label: string }[] = [
			{ id: 'system', label: localize('dispatchSettings.system', "System") },
			{ id: 'light', label: localize('dispatchSettings.lightT', "Light") },
			{ id: 'dark', label: localize('dispatchSettings.darkT', "Dark") },
		];
		const tiles: HTMLElement[] = [];
		for (const o of options) {
			const t = DOM.append(themes, $('button.dset-thm', { role: 'radio', 'aria-checked': String(o.id === current) }));
			t.dataset.mode = o.id;
			t.classList.toggle('on', o.id === current);
			const pv = DOM.append(t, $(`.dset-thm-pv.${o.id}`));
			for (const half of o.id === 'system' ? ['light', 'dark'] : [o.id]) {
				const w = DOM.append(pv, $(`.dset-mw.${half}`));
				const side = DOM.append(w, $('.dset-mw-s'));
				for (let i = 0; i < 4; i++) {
					DOM.append(side, $('i'));
				}
				DOM.append(DOM.append(w, $('.dset-mw-c')), $('i'));
			}
			DOM.append(t, $('span.dset-thm-l', undefined, o.label));
			tiles.push(t);
			store.add(DOM.addDisposableListener(t, DOM.EventType.CLICK, async () => {
				for (const x of tiles) {
					x.classList.toggle('on', x === t);
					x.setAttribute('aria-checked', String(x === t));
				}
				await this.commandService.executeCommand('_dispatch.theme.set', o.id);
			}));
		}
		note(root, localize('dispatchSettings.titleBarToo', "The button at the top right switches it too."), localize('dispatchSettings.onePlaceDetail', "System follows your Mac between day and night. The editor window looks the same."));

		groupHead(root, localize('dispatchSettings.motion', "Motion"), Codicon.pulse);
		const mb = rowsBlock(root, 'motion');
		const r = row(mb, { label: localize('dispatchSettings.animations', "Animations"), detail: localize('dispatchSettings.animationsDetail2', "Less keeps the motion that tells you something, like a working block or a spinner, and stops the decoration. None stops it all, as your Mac's Reduce motion does.") }, store);
		segmented(r.ctl, localize('dispatchSettings.animations2', "Animations"), [
			{ id: 'auto', label: localize('dispatchSettings.likeMac', "Like my Mac") },
			{ id: 'full', label: localize('dispatchSettings.full', "Full") },
			{ id: 'less', label: localize('dispatchSettings.less', "Less") },
			{ id: 'none', label: localize('dispatchSettings.none', "None") },
		], this.motionNow(), v => {
			const next = motionSettings(v as MotionChoice);
			void this.configurationService.updateValue(DISPATCH_MOTION_SETTING, next.dispatchMotion === 'less' ? 'less' : undefined, ConfigurationTarget.USER);
			void this.configurationService.updateValue('workbench.reduceMotion', next.reduce, ConfigurationTarget.USER);
		}, store);
		// what each choice keeps: a working block breathes and a tool's spinner turns under Less; the cup's steam stops
		const pv = DOM.append(mb, $('.dset-motion-preview'));
		pv.dataset.part = 'motion-preview';
		const working = DOM.append(pv, $('span.dset-motion-ex'));
		working.appendChild(stateBlock('working', { size: 14, breathe: true, title: '' }));
		DOM.append(working, $('span', undefined, localize('dispatchSettings.exWorking', "An agent is working")));
		const tool = DOM.append(pv, $('span.dset-motion-ex'));
		tool.appendChild(icon(ThemeIcon.modify(Codicon.loading, 'spin')));
		DOM.append(tool, $('span', undefined, localize('dispatchSettings.exTool', "A tool is running")));
		const deco = DOM.append(pv, $('span.dset-motion-ex.deco'));
		this.cup(deco, true, true);
		DOM.append(deco, $('span', undefined, localize('dispatchSettings.exDeco', "Steam over the cup (decoration)")));
	}

	// ---- Learning (direction B「Talk while new」, user 2026-11-15, task-q9x2r, kanban design/learn-scene) -----------

	private learning(root: HTMLElement, store: DisposableStore): void {
		groupHead(root, localize('dispatchSettings.whileWorking', "While the agent works"), Codicon.mortarBoard);
		const block = rowsBlock(root, 'learn-mode');
		const detail = (m: LearnMode) => m === 'quiet'
			? localize('dispatchSettings.quietDetail', "Nothing shows up by itself. Select anything and choose Ask Question.")
			: localize('dispatchSettings.talkDetail', "A small card when the agent adds a file, installs or deletes something. Never takes the cursor; fades in 7 s. Click it to ask in a side chat.");
		const now = learnMode(this.configurationService.getValue(LEARN_MODE_SETTING));
		const r = row(block, { label: localize('dispatchSettings.tips', "Small cards"), detail: detail(now) }, store);
		const seg = segmented<LearnMode>(r.ctl, localize('dispatchSettings.whileWorking2', "While the agent works"), [
			{ id: 'quiet', label: localize('dispatchSettings.quiet', "Quiet") },
			{ id: 'talk', label: localize('dispatchSettings.talk', "Talk") },
		], now, m => {
			r.detail.textContent = detail(m);
			void this.configurationService.updateValue(LEARN_MODE_SETTING, m, ConfigurationTarget.USER);
		}, store);
		seg.dataset.part = 'learn-mode';
		// switched from the side chat card's ⋯ while this page is open: the page follows
		store.add(this.configurationService.onDidChangeConfiguration(e => {
			if (!e.affectsConfiguration(LEARN_MODE_SETTING)) {
				return;
			}
			const m = learnMode(this.configurationService.getValue(LEARN_MODE_SETTING));
			for (const b of seg.children) {
				const on = b.textContent === (m === 'quiet' ? localize('dispatchSettings.quiet', "Quiet") : localize('dispatchSettings.talk', "Talk"));
				b.classList.toggle('on', on);
				b.setAttribute('aria-checked', String(on));
			}
			r.detail.textContent = detail(m);
		}));
		// Explain terms (task-39x97): the dotted line under common developer words, on unless switched off
		const terms = row(block, { label: localize('dispatchSettings.explainTerms', "Explain terms"), detail: localize('dispatchSettings.explainTermsDetail', "A faint dotted line under words like commit or dependency in replies and in Now. Point at one for a sentence in plain words and Ask more.") }, store);
		const termsBox = toggle(terms.ctl, localize('dispatchSettings.explainTerms', "Explain terms"), explainTermsOn(this.configurationService.getValue(EXPLAIN_TERMS_SETTING)),
			async on => { await this.configurationService.updateValue(EXPLAIN_TERMS_SETTING, on, ConfigurationTarget.USER); }, store);
		termsBox.domNode.dataset.part = 'explain-terms';
		store.add(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(EXPLAIN_TERMS_SETTING)) {
				termsBox.checked = explainTermsOn(this.configurationService.getValue(EXPLAIN_TERMS_SETTING));
			}
		}));
		note(root, localize('dispatchSettings.askAnywhere', "Ask Question works either way."), localize('dispatchSettings.askAnywhereDetail', "Select words in a reply, a file, a diff in Changes or the terminal's output and choose Ask Question. The side chat card's ⋯ switches Quiet and Talk too."));
	}

	// ---- Notifications ------------------------------------------------------------------------------------------

	/** Saves some of the notification switches; the answer is all of them, which every page then shows. */
	private async saveNotify(patch: Record<string, unknown>): Promise<boolean> {
		const ans = await this.ask<IAnswer<Record<NotifyKey, boolean> & IMacNotifyValues>>('dispatch.settings', 'save', patch);
		if (ans?.ok && ans.result) {
			settingsData.set('notify', ans.result);
		}
		return !!ans?.ok;
	}

	private notifications(root: HTMLElement, store: DisposableStore): void {
		// On this Mac: which kinds show a banner and its sound (dispatchSettingsNotify.ts), then banners for agents
		// outside the window: the same setting as the first-run wizard's "Stay in the loop", so it can be turned off again
		groupHead(root, localize('dispatchSettings.onThisMac', "On this Mac"), Codicon.bell);
		const macKinds = DOM.append(root, DOM.$('div.dset-mac-notify'));
		const mac = rowsBlock(root, 'mac-notify');
		groupHead(root, localize('dispatchSettings.tellPhone', "Tell my phone when"), Codicon.deviceMobile);
		const block = rowsBlock(root, 'phone-notify');
		const rows: [PhoneNotifyKey, string, string][] = [
			['notify_reply', localize('dispatchSettings.nReply', "An agent finished its reply"), localize('dispatchSettings.nReplyD', "So you can read it and answer from your phone.")],
			['notify_attention', localize('dispatchSettings.nAttention', "An agent waits for your OK"), localize('dispatchSettings.nAttentionD', "A command or an edit it may not make without you.")],
			['notify_done', localize('dispatchSettings.nDone', "A task is done"), localize('dispatchSettings.nDoneD', "With what came out of it.")],
			['notify_needs_you', localize('dispatchSettings.nNeedsYou', "Something only you can do comes up"), localize('dispatchSettings.nNeedsYouD', "A sign-in, a payment, a choice an agent should not make.")],
		];
		const s = settingsData.get<Record<NotifyKey, boolean> & IMacNotifyValues>('notify');
		if (!s) {
			pending(mac);
			pending(block);
		} else {
			renderMacNotify(macKinds, s, store, {
				commandService: this.commandService,
				quickInputService: this.quickInputService,
				save: patch => this.saveNotify(patch),
			});
			const outside = localize('dispatchSettings.outside', "Agents outside this window too");
			const banner = row(mac, { label: outside, detail: localize('dispatchSettings.outsideD', "Ones another agent started, ones from your phone, ones in a terminal. Dispatch's background service shows their banners, even with this window closed.") }, store);
			banner.row.dataset.notify = 'notify_desktop';
			toggle(banner.ctl, outside, s.notify_desktop, want => this.saveNotify({ notify_desktop: want }), store);
			for (const [key, label, detail] of rows) {
				const r = row(block, { label, detail }, store);
				r.row.dataset.notify = key;
				toggle(r.ctl, label, s[key], want => this.saveNotify({ [key]: want }), store);
			}
		}
		guide(root, Codicon.deviceMobile, localize('dispatchSettings.needsPhone', "These reach you once a phone is paired with this Mac."), localize('dispatchSettings.phoneGo', "Phone"), () => this.host.go('phone'), store);
	}

	// ---- Keep awake ---------------------------------------------------------------------------------------------

	private awakeMode(): AwakeMode {
		const v = this.configurationService.getValue<string>('dispatch.keepAwake');
		return v === 'display' || v === 'off' ? v : 'system';
	}

	/** Rows to pick one of (Keep awake's modes, how much agents may do on their own): a radio in front, one is
	 *  always picked; `pick` saves it and says whether it took. */
	private choiceRows<T extends string>(parent: HTMLElement, key: string, choices: readonly [T, string, string][], current: T, pick: (id: T) => Promise<boolean>, store: DisposableStore, tagged?: T): void {
		const block = rowsBlock(parent, key);
		const rowsEls: HTMLElement[] = [];
		let picked = current;
		const show = (id: T) => {
			for (const x of rowsEls) {
				const on = x.dataset.choice === id;
				x.classList.toggle('on', on);
				x.setAttribute('aria-checked', String(on));
			}
		};
		for (const [id, label, detail] of choices) {
			const r = row(block, { label, detail }, store);
			r.row.classList.add('dset-choice');
			r.row.tabIndex = 0;
			r.row.setAttribute('role', 'radio');
			r.row.dataset.choice = id;
			// data-<key>: a dataset name is camelCase (dataset['where-work'] throws, and the rest of the page was not drawn,
			// Commits and Next up included, 10-08)
			r.row.dataset[key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = id;
			if (id === tagged) {
				tag(r.label, localize('dispatchSettings.default', "Default"));
			}
			const radio = $('span.dset-radio');
			DOM.append(radio, $('i'));
			r.row.insertBefore(radio, r.row.firstChild);
			rowsEls.push(r.row);
			const choose = async () => {
				if (id === picked) {
					return;
				}
				const before = picked;
				picked = id;
				show(id);
				if (!await pick(id)) {
					picked = before;
					show(before);
				}
			};
			store.add(DOM.addDisposableListener(r.row, DOM.EventType.CLICK, () => void choose()));
			store.add(DOM.addDisposableListener(r.row, DOM.EventType.KEY_DOWN, e => {
				if (e.key === 'Enter' || e.key === ' ') {
					DOM.EventHelper.stop(e, true);
					void choose();
				}
			}));
		}
		show(current);
	}

	private cup(parent: HTMLElement, on: boolean, small = false): void {
		const c = DOM.append(parent, $(`.dset-cup${small ? '.sm' : ''}`));
		c.classList.toggle('off', !on);
		c.appendChild(icon(Codicon.coffee));
		const fx = DOM.append(c, $(on ? '.dset-steam' : '.dset-zz'));
		for (let i = 0; i < (on ? 3 : 2); i++) {
			DOM.append(fx, $('i', undefined, on ? '' : 'z'));
		}
	}

	private awake(root: HTMLElement, store: DisposableStore): void {
		const mode = this.awakeMode();
		// what Dispatch's background service holds now, as last read (Settings reads it again as it opens); read in every
		// mode, so a change made elsewhere (the bottom bar's cup panel sets the same mode) draws this page again
		const st = settingsData.get<{ mode: AwakeMode; holding: boolean; reason: string; working: number; running: boolean }>('awake');
		store.add(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('dispatch.keepAwake')) {
				const now = settingsData.get<object>('awake');
				settingsData.set('awake', { ...now, mode: this.awakeMode() });
			}
		}));
		const hero = DOM.append(root, $('.dset-hero'));
		hero.dataset.setting = 'awake';
		this.cup(hero, mode !== 'off');
		const ht = DOM.append(hero, $('.dset-hero-t'));
		DOM.append(ht, $('.dset-hero-h', undefined, mode === 'off' ? localize('dispatchSettings.heroOff', "This Mac sleeps as usual") : localize('dispatchSettings.heroWork', "This Mac stays awake while agents work")));
		const hs = DOM.append(ht, $('.dset-hero-s'));
		if (mode === 'off') {
			hs.textContent = localize('dispatchSettings.heroOffS', "Agents stop when it goes to sleep and go on when it wakes.");
		} else {
			hs.dataset.holding = String(!!st?.holding);
			hs.textContent = !st
				? ''
				: st.running === false
					? localize('dispatchSettings.awakeNoService', "Dispatch's background service is not running, so nothing keeps the Mac awake right now.")
					: st.holding && st.reason === 'phone'
						? localize('dispatchSettings.holdingPhone', "Awake right now: your phone is connected.")
						: st.holding
							? (st.working === 1 ? localize('dispatchSettings.holdingOne', "Awake right now: 1 agent is working.") : localize('dispatchSettings.holdingMany', "Awake right now: {0} agents are working.", Math.max(1, st.working)))
							: localize('dispatchSettings.notHoldingIdle', "Nothing is working right now, so the Mac may sleep as usual. It stays awake again as soon as an agent starts.");
		}

		groupHead(root, localize('dispatchSettings.whileWork', "While an agent works or your phone is connected"), Codicon.coffee);
		const choices: [AwakeMode, string, string][] = [
			['system', localize('dispatchSettings.awakeSystem', "Keep the Mac awake"), localize('dispatchSettings.awakeSystemWork', "Agents keep working and your phone can reach the Mac. The screen still sleeps and locks as usual.")],
			['display', localize('dispatchSettings.awakeDisplay', "Keep the screen on too"), localize('dispatchSettings.awakeDisplayWork', "The screen stays on while they work, for a Mac you watch from across the room.")],
			['off', localize('dispatchSettings.awakeOff', "Let the Mac sleep"), localize('dispatchSettings.awakeOffWork', "Your Mac's own energy settings decide. Agents stop while it sleeps.")],
		];
		this.choiceRows(root, 'awake', choices, mode, async m => {
			await this.configurationService.updateValue('dispatch.keepAwake', m, ConfigurationTarget.USER);
			// the bridge hands the mode to Dispatch's background service; the page follows what it holds then
			setTimeout(() => void settingsData.refresh('awake'), 600);
			return true;
		}, store, 'system');
		note(root, localize('dispatchSettings.lid', "Closing the lid still puts a MacBook to sleep,"), localize('dispatchSettings.lidDetail', "unless it is on power with an outside display. Only this Mac is affected."));
	}

	// ---- Phone ----------------------------------------------------------------------------------------------------

	private phone(root: HTMLElement, store: DisposableStore): void {
		groupHead(root, localize('dispatchSettings.phoneAccess', "Phone access"), Codicon.radioTower);
		const access = rowsBlock(root, 'phone-access');
		groupHead(root, localize('dispatchSettings.pairedPhones', "Paired phones"), Codicon.deviceMobile);
		const phones = rowsBlock(root, 'phones');
		const pairLine = DOM.append(root, $('.dset-actions'));
		pairLine.dataset.setting = 'pair';
		const pair = () => {
			// the pairing code is the title bar's: its phone button opens it right there
			void this.commandService.executeCommand('dispatch.mobile.button');
		};
		// as last read (Settings reads it again as it opens); a change below puts its answer in, and the page follows
		const s = settingsData.get<IMobileState>('mobile');
		if (!s) {
			pending(phones);
		} else {
			// what is true now, not whether a background service runs (kanban task-lj06.19): off until you pair a
			// phone; on and answering; or on and not working, with why and what to do (also while it answers: a VPN that
			// takes the local network keeps the phone out)
			const trouble = s.access === 'on' ? s.problem : undefined;
			const on = s.running && s.access !== 'off' && !trouble; // turned off: off at once, while the service is still stopping
			const starting = trouble?.reason === 'starting';
			const broken = !!trouble && !starting;
			const a = row(access, {
				label: on ? localize('dispatchSettings.accessOn', "Phone access is on") : broken ? localize('dispatchSettings.accessBroken', "Phone access is not working") : starting ? localize('dispatchSettings.accessStarting', "Phone access is turning on") : localize('dispatchSettings.accessOff', "Phone access is off"),
				detail: on ? localize('dispatchSettings.accessDetail', "Your phone reaches this Mac on the same Wi-Fi, or from anywhere through Tailscale.")
					: broken ? [trouble!.message, trouble!.fix].filter(Boolean).join(' ')
						: starting ? localize('dispatchSettings.accessStartingDetail', "It is ready in a few seconds.")
							: localize('dispatchSettings.accessOffDetail', "It turns on when you pair a phone. Until then nothing on this Mac listens for one."),
			}, store);
			a.row.dataset.access = on ? 'on' : broken ? 'problem' : starting ? 'starting' : 'off';
			if (starting) {
				// asked again every few seconds until it is on (or says why not); the page follows each new answer
				const again = setInterval(() => void settingsData.refresh('mobile'), 3000);
				store.add({ dispose: () => clearInterval(again) });
			}
			a.row.insertBefore($(`span.dset-dot${on ? '.on' : ''}`), a.row.firstChild);
			const act = (label: string, busyLabel: string, op: 'on' | 'off' | 'another-port') => {
				const b = button(a.ctl, label, async () => {
					b.enabled = false;
					b.label = busyLabel;
					const ans = await this.ask<{ state?: IMobileState }>('dispatch.mobile', op);
					if (ans?.state) {
						settingsData.set('mobile', ans.state);
					} else {
						await settingsData.refresh('mobile');
					}
				}, store);
				return b;
			};
			if (on) {
				act(localize('dispatchSettings.turnOff', "Turn off"), localize('dispatchSettings.turningOff', "Turning off…"), 'off');
			} else if (broken) {
				if (trouble!.reason === 'port_in_use' || trouble!.reason === 'not_allowed') {
					act(localize('dispatchSettings.anotherPort', "Use another port"), localize('dispatchSettings.turningOn', "Turning on…"), 'another-port');
				}
				act(localize('dispatchSettings.tryAgain', "Try again"), localize('dispatchSettings.turningOn', "Turning on…"), 'on');
				act(localize('dispatchSettings.turnOff', "Turn off"), localize('dispatchSettings.turningOff', "Turning off…"), 'off');
			} else if (!starting && s.phones.length) {
				act(localize('dispatchSettings.turnOn', "Turn on"), localize('dispatchSettings.turningOn', "Turning on…"), 'on');
			}
			if (!s.phones.length) {
				const e = empty(phones, Codicon.deviceMobile, localize('dispatchSettings.noPhone', "No phone yet"), localize('dispatchSettings.noPhoneTextSoon', "Pair your iPhone to see what agents are doing, answer when one needs you, and get notifications. Dispatch for iPhone is not in the App Store yet; it is coming soon."));
				button(e, localize('dispatchSettings.pair', "Pair a phone"), pair, store, true);
			} else {
				for (const p of s.phones) {
					const r = row(phones, { label: p.name, detail: p.pairedAt ? localize('dispatchSettings.pairedOn', "Paired {0}", new Date(p.pairedAt * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })) : undefined, icon: Codicon.deviceMobile }, store);
					button(r.ctl, localize('dispatchSettings.removePhone', "Remove"), async () => {
						await this.ask('dispatch.mobile', 'revoke', p.id);
						await settingsData.refresh('mobile');
					}, store);
				}
				button(pairLine, localize('dispatchSettings.pairAnother', "Pair another phone"), pair, store);
			}
		}
		note(root, localize('dispatchSettings.phoneButton', "The phone button at the top right of the window"), localize('dispatchSettings.phoneButtonDetail', "opens the same pairing code, from any page."), Codicon.deviceMobile);
		guide(root, Codicon.bell, localize('dispatchSettings.whatPhoneHears', "Choose what your phone hears about."), localize('dispatchSettings.notifyGo', "Notifications"), () => this.host.go('notifications'), store);
	}

	// ---- Macs -----------------------------------------------------------------------------------------------------

	private macs(root: HTMLElement, store: DisposableStore): void {
		const head = groupHead(root, localize('dispatchSettings.yourMacs', "Your Macs"), Codicon.vm);
		const addWrap = DOM.append(head, $('span.dset-gh-r'));
		button(addWrap, localize('dispatchSettings.addMac', "Add a Mac…"), () => this.commandService.executeCommand(DISPATCH_MACHINES_ADD), store);
		const block = rowsBlock(root, 'macs');
		const wait = pending(block);
		void refreshDispatchMachines(this.commandService);
		const inner = store.add(new DisposableStore());
		store.add(autorun(reader => {
			const list = dispatchMachines.read(reader);
			if (!list) {
				return;
			}
			wait.remove();
			inner.clear();
			DOM.clearNode(block);
			for (const m of [...list].sort((a, b) => (b.local ? 1 : 0) - (a.local ? 1 : 0))) {
				this.macRow(block, m, inner);
			}
			this.host.relayout();
		}));
	}

	private macRow(block: HTMLElement, m: IDispatchMachine, store: DisposableStore): void {
		const r = row(block, { label: m.name, detail: [m.local ? localize('dispatchSettings.thisMacT', "This Mac") : m.ssh, m.dispatch_version ? localize('dispatchSettings.dispatchV', "Dispatch {0}", m.dispatch_version) : ''].filter(Boolean).join(' · '), icon: Codicon.vm }, store);
		const state = DOM.append(r.ctl, $('span.dset-quiet'));
		DOM.append(state, $(`span.dset-dot${m.online ? '.on' : ''}`));
		DOM.append(state, $('span', undefined, m.online ? localize('dispatchSettings.online', "Online") : localize('dispatchSettings.offline', "Offline")));
		const edit = (what: 'rename' | 'address' | 'remove') => this.instantiationService.invokeFunction(a => editMachine(a, m, what));
		button(r.ctl, localize('dispatchSettings.rename', "Rename"), () => edit('rename'), store);
		if (!m.local) {
			button(r.ctl, localize('dispatchSettings.address', "Address"), () => edit('address'), store);
			button(r.ctl, localize('dispatchSettings.removeMac', "Remove"), () => edit('remove'), store);
		}
	}

	// ---- Projects -------------------------------------------------------------------------------------------------

	private projects(root: HTMLElement, store: DisposableStore): void {
		const head = groupHead(root, localize('dispatchSettings.inTheSidebar', "In the side bar"), Codicon.folder);
		const count = DOM.append(head, $('span.dset-gh-r'));
		const block = rowsBlock(root, 'projects');
		const wait = pending(block);
		const archivedHead = groupHead(root, localize('dispatchSettings.archived', "Archived"), Codicon.archive);
		const archived = rowsBlock(root);
		const home = this.pathService.resolvedUserHome?.fsPath;
		void refreshDispatchProjectsRegistry();
		const inner = store.add(new DisposableStore());
		store.add(autorun(reader => {
			const all = dispatchProjectsRegistry.read(reader);
			if (!all) {
				return;
			}
			wait.remove();
			inner.clear();
			DOM.clearNode(block);
			DOM.clearNode(archived);
			const live = all.filter(p => !p.archived);
			const old = all.filter(p => p.archived);
			count.textContent = live.length === 1 ? localize('dispatchSettings.oneShown', "1 project") : localize('dispatchSettings.nShown', "{0} projects", live.length);
			if (!live.length) {
				// the button that adds one is here: the new session page has none (kanban task-xw428)
				const e = empty(block, Codicon.folder, localize('dispatchSettings.noProjects', "No projects yet"), localize('dispatchSettings.noProjectsText', "A project is a folder you work in with your agents."));
				button(e, localize('dispatchSettings.addProject', "Add Project"), () => this.commandService.executeCommand('dispatch.addProject.show'), inner, true);
			}
			// by place (This Mac, iCloud Drive, another Mac, Not found), named only when there is more than one
			const groups = groupByPlace(live, p => projectPlace(p, home));
			for (const g of groups) {
				if (groups.length > 1) {
					DOM.append(block, $('.dset-row-group', undefined, placeName(g.name)));
				}
				for (const p of g.items) {
					this.projectRow(block, p, home, inner);
				}
			}
			archivedHead.hidden = archived.hidden = !old.length;
			for (const p of old) {
				this.projectRow(archived, p, home, inner);
			}
			this.host.relayout();
		}));
	}

	/** One project: its name on one line, where it is on one line, every row the same height (kanban task-8eudz). */
	private projectRow(block: HTMLElement, p: IDispatchProject, home: string | undefined, store: DisposableStore): void {
		const place = projectPlace(p, home);
		const r = row(block, { label: p.label || p.name, icon: Codicon.folder, onClick: () => { this.host.close(); void this.commandService.executeCommand('dispatch.projects.open', p.name); } }, store);
		r.row.dataset.project = p.name;
		r.row.dataset.place = place.kind;
		r.row.classList.add('dset-row-fixed');
		r.detail.hidden = false;
		r.detail.classList.add('dset-path');
		if (place.note) {
			DOM.append(r.detail, $('span.dset-path-note', undefined, placeNote(place.note)));
		}
		if (place.note && place.path) {
			DOM.append(r.detail, $('span.dset-path-sep', undefined, ' · '));
		}
		if (place.path) {
			// cut in the middle: the folders before the last one give way first, the project's own folder stays
			const { head: before, tail } = splitPathTail(place.path);
			if (before) {
				DOM.append(r.detail, $('span.dset-path-head', undefined, before));
			}
			DOM.append(r.detail, $('span.dset-path-tail', undefined, tail));
		}
		if (place.full) {
			r.detail.setAttribute('aria-label', place.full);
			store.add(setupDispatchTextHover(this.hoverService, r.detail, () => ({ head: p.label || p.name, notes: [place.kind === 'missing' ? `${placeNote(place.note)}: ${place.full}` : place.full] }), { when: () => true }));
		}
		// Dispatch IDE: the project's own icon, and its Customize page (dispatchProjectCustom)
		const look = dispatchProjectLook((p as { look?: unknown }).look);
		if (look) {
			DOM.clearNode(r.lead);
			paintDispatchProjectLook(DOM.append(r.lead, DOM.$('span.dset-ic.dset-project-look')), look);
		}
		if (p.host === 'local') {
			const customize = button(r.ctl, localize('dispatchSettings.customizeProject', "Customize"), () => {
				this.host.close();
				void this.commandService.executeCommand('dispatch.project.customize', p.name);
			}, store);
			customize.element.classList.add('dset-hover-only');
			// the project's name itself, its tasks and the rest moving along (dispatchProjects.ts, task-ysxde)
			const rename = button(r.ctl, localize('dispatchSettings.renameProject', "Rename"), () => {
				void this.commandService.executeCommand('dispatch.project.rename', p.name);
			}, store);
			rename.element.classList.add('dset-hover-only');
		}
	}

	// ---- Abilities ------------------------------------------------------------------------------------------------

	private abilities(root: HTMLElement, store: DisposableStore): void {
		const block = rowsBlock(root);
		const details: Record<string, string> = {
			skills: localize('dispatchSettings.aSkills', "Know-how an agent loads when a task needs it."),
			tools: localize('dispatchSettings.aToolsBuiltin', "Tool servers agents can call, such as a browser. Dispatch's own is one of them."),
			plugins: localize('dispatchSettings.aPlugins', "Claude Code plugins on this Mac, each with its switch."),
			hooks: localize('dispatchSettings.aHooks', "What runs by itself when a session starts, stops or edits a file."),
			instructions: localize('dispatchSettings.aInstructions', "The rules every agent reads, kept in step across them."),
			subagents: localize('dispatchSettings.aSubagents', "Helpers an agent can hand part of a task to."),
			knowledge: localize('dispatchSettings.aKnowledge', "What agents know about you and your work."),
		};
		const counts = new Map<string, HTMLElement>();
		for (const a of ABILITIES) {
			const r = row(block, { label: a.label, detail: details[a.id], icon: a.icon, onClick: () => this.host.go(a.id) }, store);
			r.row.dataset.ability = a.id;
			counts.set(a.id, DOM.append(r.ctl, $('span.dset-quiet')));
		}
		store.add(autorun(reader => {
			const set = (id: string, n: number) => { const el = counts.get(id); if (el) { el.textContent = String(n); } };
			set('skills', this.itemsModel.getCount(AICustomizationManagementSection.Skills).read(reader));
			set('tools', toolCount(this.mcpService.servers.read(reader).length, reader));
			set('plugins', this.itemsModel.getPluginCount().read(reader));
			set('hooks', this.itemsModel.getCount(AICustomizationManagementSection.Hooks).read(reader));
			set('instructions', this.itemsModel.getCount(AICustomizationManagementSection.Instructions).read(reader));
			set('subagents', this.itemsModel.getCount(AICustomizationManagementSection.Agents).read(reader));
		}));
		groupHead(root, localize('dispatchSettings.moreHead', "More"), Codicon.ellipsis);
		const more = rowsBlock(root);
		row(more, { label: localize('dispatchSettings.findSkills', "Find skills"), detail: localize('dispatchSettings.findSkillsDetail', "Search your skill pool first, then skills.sh, and add one to your agents."), icon: Codicon.search, onClick: () => this.host.go('findskills') }, store).row.dataset.ability = 'findskills';
		row(more, { label: localize('dispatchSettings.changes', "What Dispatch changed on this Mac"), detail: localize('dispatchSettings.changesDetail', "Everything Dispatch set up or brought over from other apps, each with Undo."), icon: Codicon.history, onClick: () => this.host.go('changes') }, store).row.dataset.ability = 'changes';
	}

	// ---- search results -------------------------------------------------------------------------------------------

	private results(root: HTMLElement, store: DisposableStore, query: string): void {
		const hits = searchSettings(query);
		if (!hits.length) {
			empty(root, Codicon.search, localize('dispatchSettings.nothing', "Nothing called “{0}”", query.trim()), localize('dispatchSettings.nothingText', "Try a plainer word: sleep, dark, phone, account."));
			return;
		}
		const block = rowsBlock(root);
		block.classList.add('dset-results');
		for (const h of hits) {
			const r = row(block, { label: '', detail: h.entry.detail, onClick: () => this.host.go(h.entry.page, h.entry.key) }, store);
			const parts = matchParts(h.entry.label, query);
			if (parts) {
				r.label.append(parts[0]);
				DOM.append(r.label, $('mark', undefined, parts[1]));
				r.label.append(parts[2]);
			} else {
				r.label.textContent = h.entry.label;
			}
			DOM.append(r.text, $('.dset-crumbs', undefined, pageTitle(h.entry.page)));
		}
	}
}
