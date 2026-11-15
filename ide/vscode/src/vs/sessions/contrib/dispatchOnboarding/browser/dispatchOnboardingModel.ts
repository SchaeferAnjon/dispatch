/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the setup wizard's data and rules (kanban design/onboarding/redesign, direction A;
 *  kanban app/cli/onboarding.py is what it asks). No services in here: the page and its tests use it.
 *
 *  Four screens (Agents, Projects, Preferences, Rules), two on a Mac with nothing to bring over
 *  (Agents, Rules). Nothing is changed while someone clicks through: the choices are collected and
 *  "Set up Dispatch" runs them in order (runSetup), each step reported as it finishes.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentRow } from '../../dispatchAgents/browser/dispatchAgentsModel.js';
import type { IAutonomy, ThemeMode } from '../../dispatchAgents/browser/dispatchFirstRunModel.js';
import type { IOnboardingNetwork } from '../../dispatchNet/common/dispatchNetModel.js';
import type { IDispatchGitIdentity } from '../../dispatchCommon/browser/dispatchGitIdentity.js';

export type OnboardingStep = 'agents' | 'projects' | 'prefs' | 'autonomy' | 'appearance' | 'notifications' | 'rules';

export function onboardingSteps(fresh: boolean, requested?: OnboardingStep): readonly OnboardingStep[] {
	return fresh && requested !== 'projects' && requested !== 'prefs'
		? ['agents', 'autonomy', 'appearance', 'notifications', 'rules']
		: ['agents', 'projects', 'prefs', 'autonomy', 'appearance', 'notifications', 'rules'];
}

/** Where someone stands once the session history is read, when they went on before it was: until then the wizard
 *  does not know the person is new and shows the projects and preferences pages; a new person (nothing to bring
 *  over) skips those two, so they go on to the page after them (agent permissions), not to the last page. */
export function stepAfterHistoryRead(fresh: boolean, phase: string): OnboardingStep | undefined {
	if (!fresh || (phase !== 'projects' && phase !== 'prefs')) {
		return undefined;
	}
	const steps = onboardingSteps(true);
	return steps[steps.indexOf('agents') + 1];
}

export interface IOnboardingEngine {
	readonly id: 'claude' | 'codex' | 'opencode';
	readonly name: string;
	readonly installed: boolean;
	readonly version: string;
	readonly account: string;
	readonly install: string;
	/** Why it cannot be installed on this Mac (no installer: Codex without Node.js), when `install` is empty. */
	readonly install_why?: string;
	readonly sessions: number | null;
}

export interface IOnboardingIndex {
	readonly state: 'idle' | 'running' | 'done' | 'interrupted';
	readonly done: number | null;
	readonly total: number | null;
}

export interface IOnboardingVscodeSummary {
	readonly settings: number;
	readonly settings_total: number;
	readonly extensions: number;
	readonly extensions_total: number;
	readonly keybindings: number;
	readonly snippets: number;
}

export interface IOnboardingStatus {
	readonly needed: boolean;
	readonly draft?: Record<string, unknown>;
	readonly state: 'pending' | 'skipped' | 'done';
	readonly step: OnboardingStep;
	readonly board: { readonly exists: boolean };
	readonly engines: readonly IOnboardingEngine[];
	/** Every agent CLI the CLI knows by name, found or not, with the person's choice (agents_catalog.py). */
	readonly agents?: readonly IAgentRow[];
	/** How much agents may do on their own: the three answers and the saved one (autonomy.py). */
	readonly autonomy?: IAutonomy;
	readonly others: readonly string[];
	readonly index: IOnboardingIndex;
	readonly history: { readonly sessions: number | null };
	readonly fresh: boolean | null;
	readonly vscode: IOnboardingVscodeSummary | null;
	readonly steps: readonly OnboardingStep[];
	/** Can Claude Code and Codex reach their servers from here, and the Chinese models OpenCode offers (patches/270-network.patch). */
	readonly network?: IOnboardingNetwork | null;
	/** The name and email on commits: what git has, and what to offer when it has none (kanban git_identity.py, task-pog4t). */
	readonly git_identity?: IDispatchGitIdentity | null;
}

export interface IOnboardingFolder {
	readonly dir: string;
	readonly display: string;
	readonly name: string;
	readonly git: boolean;
	readonly sessions: number;
	readonly days: number;
	readonly reason: string;
	readonly icloud: boolean;
}

export interface IOnboardingPrefItem {
	readonly n: number;
	readonly polarity: 'like' | 'avoid';
	readonly area: string;
	readonly text: string;
	readonly name: string;
	readonly source: string;
	readonly why?: string;
}

export interface IOnboardingPrefGroup {
	readonly id: string;
	readonly name: string;
	readonly n: number;
	readonly like: number;
	readonly avoid: number;
	readonly items: readonly IOnboardingPrefItem[];
}

export interface IOnboardingPrefs {
	readonly total: number;
	readonly clear: number;
	readonly look: number;
	readonly left: number;
	readonly sources: string;
	readonly groups: readonly IOnboardingPrefGroup[];
	readonly look_items: readonly IOnboardingPrefItem[];
}

export interface IOnboardingRulesAgent {
	readonly id: 'claude' | 'codex' | 'opencode';
	readonly name: string;
	readonly path: string;
	readonly own_lines: number;
	readonly block_lines: number;
	readonly hooks: string;
	readonly hooks_note: string;
}

export interface IOnboardingRulesFile {
	readonly id: string;
	readonly lines: number;
	readonly note: string;
}

export interface IOnboardingRules {
	readonly agents: readonly IOnboardingRulesAgent[];
	readonly files: readonly IOnboardingRulesFile[];
	readonly left_alone: readonly string[];
}

export interface IOnboardingVscodeScan {
	readonly settings: {
		readonly total: number;
		readonly core: readonly { readonly key: string }[];
		readonly with_extension: readonly { readonly key: string; readonly with: string; readonly ext: string }[];
		readonly skip: readonly { readonly key: string; readonly why: string }[];
	};
	readonly keybindings: { readonly found: boolean; readonly count: number };
	readonly snippets: { readonly files: readonly string[] };
	readonly extensions: {
		readonly total: number;
		readonly install: readonly { readonly id: string; readonly name: string }[];
		readonly builtin: readonly { readonly id: string; readonly name: string; readonly why: string }[];
		readonly theme: readonly { readonly id: string; readonly name: string; readonly why: string }[];
		readonly tweak: readonly { readonly id: string; readonly name: string; readonly why: string }[];
		readonly missing: readonly { readonly id: string; readonly name: string; readonly why: string }[];
	};
}

export interface IOnboardingLogItem {
	readonly id: string;
	readonly key: string;
	readonly kind: string;
	readonly title: string;
	readonly detail: string;
	readonly at: number;
	readonly undone: boolean;
}

/** What the page asks of the outside: the bridge, settings, the window. */
export interface IOnboardingHost {
	/** `dispatch.onboarding` (dispatch-bridge). */
	ask<T = unknown>(op: string, arg?: unknown, extra?: unknown): Promise<T>;
	/** `dispatch engines upgrade <id>`: installs an engine that is not there yet. */
	installEngine(id: string): Promise<void>;
	/** Sessions › Filter › External. */
	setExternalRange(mode: ExternalRange): Promise<void>;
	/** Opens the sign-in page of Claude Code or Codex in the browser and answers when the person is done (`dispatch engines login`). */
	signIn(id: string): Promise<{ ok: boolean; message: string }>;
	/** The name, then the email, on commits (the command palette's input); undefined when the person backs out. */
	askGitIdentity(start: { readonly name: string; readonly email: string }): Promise<{ name: string; email: string } | undefined>;
	/** `dispatch.firstRun` (dispatch-bridge): System Settings at Notifications. */
	firstRun<T = unknown>(op: string, arg?: unknown): Promise<T>;
	/** A test banner from the app itself (dispatchNotifyTest.ts): what to say under the button. */
	notifyTest(): Promise<{ ok: boolean; message: string }>;
	/** OpenCode's `opencode auth login` in a terminal under the wizard (dispatch-bridge); answers once it is closed. */
	addProvider(): Promise<void>;
	/** The theme the window uses now, and a new one (it applies at once: it is the preview). */
	getTheme(): Promise<ThemeMode>;
	setTheme(mode: ThemeMode): Promise<void>;
	/** The wizard is over (done or skipped): the window goes back to where it was. */
	leave(done: boolean): void;
	/** After a step ran the sidebar and Projects page have new content. */
	refresh(): Promise<void>;
	notify(message: string): void;
}

// ---- the time range -------------------------------------------------------------------------------

/** Values of chat.agentSessions.showExternal (patches/sessions-external-range.patch adds the last two). */
export type ExternalRange = 'last24Hours' | 'last7Days' | 'last30Days' | 'last90Days' | 'allTime';

export interface IRangeOption {
	readonly id: ExternalRange;
	readonly label: string;
	readonly days: number;
}

export const RANGE_OPTIONS: readonly IRangeOption[] = [
	{ id: 'last24Hours', label: 'Last 24 Hours', days: 1 },
	{ id: 'last7Days', label: 'Last 7 Days', days: 7 },
	{ id: 'last30Days', label: 'Last 30 Days', days: 30 },
	{ id: 'last90Days', label: 'Last 90 Days', days: 90 },
	{ id: 'allTime', label: 'All time', days: Number.POSITIVE_INFINITY },
];
export const DEFAULT_RANGE: ExternalRange = 'last30Days';

export function rangeDays(id: ExternalRange): number {
	return RANGE_OPTIONS.find(r => r.id === id)?.days ?? 30;
}

/** In the range, and nothing about the folder says it should wait: ticked by default. */
export function defaultFolderSelection(rows: readonly IOnboardingFolder[], range: ExternalRange): Set<string> {
	const days = rangeDays(range);
	return new Set(rows.filter(r => r.days <= days && !r.reason).map(r => r.dir));
}

export function folderCounts(rows: readonly IOnboardingFolder[], range: ExternalRange, selected: ReadonlySet<string>): { inRange: number; selectedIn: number; selectedOlder: number; older: number; sessions: number } {
	const days = rangeDays(range);
	let inRange = 0, selectedIn = 0, selectedOlder = 0, older = 0, sessions = 0;
	for (const r of rows) {
		const isIn = r.days <= days;
		if (isIn) {
			inRange++;
		} else {
			older++;
		}
		if (selected.has(r.dir)) {
			isIn ? selectedIn++ : selectedOlder++;
			sessions += r.sessions;
		}
	}
	return { inRange, selectedIn, selectedOlder, older, sessions };
}

export function plural(n: number, one: string, many: string): string {
	return n === 1 ? one : many;
}

/** "2d", "5h", "now": the age column. */
export function ageLabel(days: number): string {
	if (days < 0.04) {
		return 'now';
	}
	if (days < 1) {
		return `${Math.max(1, Math.round(days * 24))}h`;
	}
	if (days < 30) {
		return `${Math.round(days)}d`;
	}
	if (days < 365) {
		return `${Math.round(days / 30)}mo`;
	}
	return `${Math.round(days / 365)}y`;
}

/** "~/Library/Mobile Documents/com~apple~CloudDocs/Course/notes" → "iCloud Drive/Course/notes"; long ones shortened in the middle. */
export function pathLabel(display: string, max = 46): string {
	let p = display.replace(/^~\/Library\/Mobile Documents\/com~apple~CloudDocs/, 'iCloud Drive').replace(/^~\/Library\/Mobile Documents\/iCloud~md~obsidian\/Documents/, 'iCloud Drive/Obsidian');
	if (p.length > max) {
		const k = Math.floor((max - 1) / 2);
		p = `${p.slice(0, k)}…${p.slice(p.length - k)}`;
	}
	return p;
}

// ---- preferences ----------------------------------------------------------------------------------

/** The plan numbers to import: every item of the ticked groups (minus the ones unticked one by one) and the ticked "to look at" ones. */
export function prefPicks(plan: IOnboardingPrefs, groupOff: ReadonlySet<string>, itemOff: ReadonlySet<number>, lookOn: ReadonlySet<number>): number[] {
	const picks: number[] = [];
	for (const g of plan.groups) {
		if (groupOff.has(g.id)) {
			continue;
		}
		for (const it of g.items) {
			if (!itemOff.has(it.n)) {
				picks.push(it.n);
			}
		}
	}
	for (const it of plan.look_items) {
		if (lookOn.has(it.n)) {
			picks.push(it.n);
		}
	}
	return picks;
}

/** [1,2,3,5] → "1-3,5". */
export function picksString(numbers: readonly number[]): string {
	const sorted = [...new Set(numbers)].sort((a, b) => a - b);
	const parts: string[] = [];
	for (let i = 0; i < sorted.length;) {
		let j = i;
		while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) {
			j++;
		}
		parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
		i = j + 1;
	}
	return parts.join(',');
}

// ---- running the setup ---------------------------------------------------------------------------

export interface ISetupChoices {
	readonly agents: readonly ('claude' | 'codex' | 'opencode')[];
	readonly range: ExternalRange;
	readonly folders: readonly { readonly dir: string; readonly name: string }[];
	readonly picks: string;
	/** Which agents the person uses: the ones Dispatch runs that were unticked, the others that were ticked. */
	readonly use?: { readonly off: readonly string[]; readonly on: readonly string[]; readonly default: string };
	/** How much agents may do on their own (autonomy level id), always saved. */
	readonly autonomy?: string;
	/** Banners on this Mac (notify_desktop) and keeping the Mac awake (keep_awake). Only the ones that differ from the default are saved. */
	readonly notify?: boolean;
	readonly awake?: boolean;
	/** The name and email on commits, saved into git's settings: only on a Mac where git has none (task-pog4t). */
	readonly gitIdentity?: { readonly name: string; readonly email: string };
	readonly vscode?: { readonly settings: readonly string[]; readonly keybindings: boolean; readonly snippets: boolean; readonly extensions: readonly string[] };
}

export interface ISetupStep {
	readonly id: string;
	readonly label: string;
	readonly detail?: string;
}

export type SetupState = 'pending' | 'running' | 'done' | 'failed';

/** The steps "Set up Dispatch" will run, in order. */
export function setupSteps(c: ISetupChoices): ISetupStep[] {
	const out: ISetupStep[] = [{ id: 'index', label: 'Reading your session history' }, { id: 'prepare', label: 'Preparing your local task board and rules' }];
	if (c.use) {
		out.push({ id: 'agents', label: 'Saving which agents you use' });
	}
	if (c.autonomy) {
		out.push({ id: 'autonomy', label: 'Saving agent permissions' });
	}
	if (c.gitIdentity) {
		out.push({ id: 'identity', label: 'Saving your name on commits' });
	}
	if (c.notify) {
		out.push({ id: 'notify', label: 'Turning on notifications on this Mac' });
	}
	if (c.awake === false) {
		out.push({ id: 'awake', label: 'Letting this Mac sleep as usual' });
	}
	if (c.folders.length) {
		out.push({ id: 'projects', label: `Adding ${c.folders.length} ${plural(c.folders.length, 'project', 'projects')}` });
	}
	if (c.picks) {
		out.push({ id: 'prefs', label: 'Importing preferences' });
	}
	if (c.agents.length) {
		out.push({ id: 'rules', label: `Writing rules and hooks for ${c.agents.length} ${plural(c.agents.length, 'agent', 'agents')}` });
		out.push({ id: 'skills', label: 'Adding Dispatch\'s skills and helper agents' });
	}
	out.push({ id: 'command', label: 'Making the dispatch command work in Terminal' });
	if (c.vscode) {
		out.push({ id: 'vscode', label: 'Importing from VS Code' });
	}
	return out;
}

export type StepReporter = (id: string, state: SetupState, detail?: string) => void;

/**
 * The work, one CLI call per step. A step that fails is reported and the others still run (a failed
 * skill mount should not leave the projects out); the caller says what failed.
 */
export async function runSetup(host: IOnboardingHost, c: ISetupChoices, report: StepReporter, waitIndex: () => Promise<void>, completed: ReadonlySet<string> = new Set()): Promise<string[]> {
	const failed: string[] = [];
	const step = async (id: string, work: () => Promise<string | undefined>): Promise<void> => {
		if (completed.has(id)) { return; }
		report(id, 'running');
		try {
			report(id, 'done', await work());
		} catch (e) {
			failed.push(id);
			report(id, 'failed', String((e as Error)?.message ?? e));
		}
	};
	const ok = <T>(answer: T): T => {
		const a = answer as { ok?: boolean; message?: string } | undefined;
		if (a && a.ok === false) {
			throw new Error(a.message || 'That did not work.');
		}
		return answer;
	};
	await step('index', async () => { await waitIndex(); return undefined; });
	if (failed.length) { return failed; }
	await step('prepare', async () => { ok(await host.ask('apply-dir')); await host.setExternalRange(c.range); return undefined; });
	if (failed.length) { return failed; }
	if (c.use) {
		const use = c.use;
		await step('agents', async () => { ok(await host.ask('agents-use', use)); return undefined; });
	}
	if (c.autonomy) {
		const level = c.autonomy;
		await step('autonomy', async () => { ok(await host.ask('autonomy-set', { level })); return undefined; });
	}
	if (c.gitIdentity) {
		const who = c.gitIdentity;
		await step('identity', async () => { ok(await host.ask('git-identity-set', who)); return undefined; });
	}
	if (c.notify) {
		await step('notify', async () => { ok(await host.ask('notify-set', { on: true })); return undefined; });
	}
	if (c.awake === false) {
		await step('awake', async () => { ok(await host.ask('awake-set', { on: false })); return undefined; });
	}
	if (c.folders.length) {
		await step('projects', async () => {
			await host.setExternalRange(c.range);
			const res = ok(await host.ask<{ added: unknown[]; failed: { message: string }[] }>('register', c.folders.map(f => ({ dir: f.dir, name: f.name }))));
			await host.refresh();
			if (res.failed?.length) {
				throw new Error(res.failed[0].message);
			}
			return res.failed?.length ? `${res.added.length} added, ${res.failed.length} could not be` : `${res.added.length} ${plural(res.added.length, 'project', 'projects')}`;
		});
	}
	if (c.picks) {
		await step('prefs', async () => {
			const res = ok(await host.ask<{ imported: number }>('prefs-apply', c.picks));
			return `${res.imported}`;
		});
	}
	if (c.agents.length) {
		await step('rules', async () => {
			ok(await host.ask('apply-rules', c.agents.join(',')));
			return undefined;
		});
		await step('skills', async () => { ok(await host.ask('apply-skills', c.agents.join(','))); return undefined; });
	}
	await step('command', async () => { ok(await host.ask('apply-command')); return undefined; });
	if (c.vscode) {
		const v = c.vscode;
		await step('vscode', async () => {
			ok(await host.ask('vscode-apply', { settings: v.settings, keybindings: v.keybindings, snippets: v.snippets }));
			if (v.extensions.length) {
				ok(await host.ask('install-extensions', v.extensions));
			}
			return undefined;
		});
	}
	return failed;
}
