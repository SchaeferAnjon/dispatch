/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the setup wizard's screens (kanban design/onboarding/redesign, direction A). The
 *  controller holds what the person has chosen (it outlives the view, which is disposed whenever
 *  another page is shown); the page draws it. Flat, one solid button per screen, lists in a well,
 *  a 12px grey group head, checkboxes; colour nowhere (DESIGN.md).
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchOnboarding.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { SelectBox } from '../../../../base/browser/ui/selectBox/selectBox.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { Checkbox } from '../../../../base/browser/ui/toggle/toggle.js';
import { defaultButtonStyles, defaultCheckboxStyles, defaultSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import '../../../../workbench/contrib/chat/browser/agentSessions/dispatchEngineIcons.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import {
	ageLabel, DEFAULT_RANGE, defaultFolderSelection, ExternalRange, folderCounts, IOnboardingEngine, IOnboardingFolder, IOnboardingHost, IOnboardingPrefs, IOnboardingRules,
	IOnboardingStatus, IOnboardingVscodeScan, ISetupChoices, ISetupStep, OnboardingStep, onboardingSteps, pathLabel, picksString, plural, prefPicks, RANGE_OPTIONS, rangeDays, runSetup, SetupState, setupSteps, stepAfterHistoryRead,
} from './dispatchOnboardingModel.js';
import { effectiveDefault, IAgentRow, NOT_RUNNABLE, wizardChoice } from '../../dispatchAgents/browser/dispatchAgentsModel.js';
import { AWAKE_TEXT, chosenAutonomy, DEFAULT_AUTONOMY, NOTIFY_TEXT, THEME_CHOICES, ThemeMode } from '../../dispatchAgents/browser/dispatchFirstRunModel.js';
import { agentIcon } from '../../dispatchAgents/browser/dispatchAgentIcons.js';
import { wizardDefault } from '../../dispatchNet/common/dispatchNetModel.js';
import { appendWizardNetwork } from '../../dispatchNet/browser/dispatchNetViews.js';
import { gitIdentityLine, gitIdentityProblem } from '../../dispatchCommon/browser/dispatchGitIdentity.js';

const $ = DOM.$;
const FIRST_ROWS = 12;
const FIRST_ITEMS = 5;
const STEP_LABEL: Record<OnboardingStep, string> = { agents: 'Agents', projects: 'Projects', prefs: 'Preferences', autonomy: 'Autonomy', appearance: 'Appearance', notifications: 'Notifications', rules: 'Rules' };

export type WizardPhase = OnboardingStep | 'running' | 'finished';

/** What the wizard knows and what has been chosen so far. Module-level: the view is rebuilt whenever it is shown again. */
export class OnboardingController extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	phase: WizardPhase = 'agents';
	status: IOnboardingStatus | undefined;
	statusError: string | undefined;
	folders: readonly IOnboardingFolder[] | undefined;
	range: ExternalRange = DEFAULT_RANGE;
	selected = new Set<string>();
	showAllFolders = false;
	olderOpen = false;
	names = new Map<string, string>();
	prefs: IOnboardingPrefs | undefined;
	groupOff = new Set<string>();
	itemOff = new Set<number>();
	lookOn = new Set<number>();
	groupOpen = new Set<string>(['workflow']);
	groupAll = new Set<string>();
	lookOpen = false;
	rules: IOnboardingRules | undefined;
	agentOff = new Set<string>();
	engineOff = new Set<string>();
	/** Agents Dispatch cannot run yet that were ticked (they are off until then). */
	agentOn = new Set<string>();
	/** The agent a new session starts with, as chosen by hand ('' = the first one that is on). */
	agentDefault = '';
	/** How much agents may do on their own, as chosen by hand ('' = the saved level, else the default). */
	autonomy = '';
	/** The name and email on commits, as typed (undefined = the suggestion), on a Mac where git has none (task-pog4t). */
	gitIdentity: { name: string; email: string } | undefined;
	/** The theme in use ('' until it is read) and which sign-in is open. */
	theme: ThemeMode | undefined;
	signingIn = new Set<string>();
	/** OpenCode's Add provider is waiting for its terminal to close. */
	addingProvider = false;
	signInMessage: string | undefined;
	/** Banners on this Mac (off until ticked) and keeping the Mac awake (on until unticked). */
	notifyOn = false;
	awakeOn = true;
	notifyMessage: string | undefined;
	installing = new Set<string>();
	vscodeOn = false;
	vscodeSheet = false;
	vscodeScan: IOnboardingVscodeScan | undefined;
	vscodeLoading = false;
	vscodeError: string | undefined;
	vscodeSettingsOff = new Set<string>();
	vscodeExtOff = new Set<string>();
	vscodeKeys = true;
	vscodeSnippets = true;
	steps: ISetupStep[] = [];
	stepState = new Map<string, { state: SetupState; detail?: string }>();
	failed: string[] = [];
	private pollTimer: ReturnType<typeof setTimeout> | undefined;
	private started = false;
	private requestedStep: OnboardingStep | undefined;
	private draftTimer: ReturnType<typeof setTimeout> | undefined;
	private restoredSelection: string[] | undefined;
	readonly completed = new Set<string>();
	readonly reviewed = new Set<OnboardingStep>();

	constructor(readonly host: IOnboardingHost) {
		super();
		this._register(toDisposable(() => { this.stopPolling(); if (this.draftTimer) { clearTimeout(this.draftTimer); } }));
	}

	fire(): void {
		this._onDidChange.fire();
		if (this.status && this.phase !== 'running' && this.phase !== 'finished') {
			if (this.draftTimer) { clearTimeout(this.draftTimer); }
			this.draftTimer = setTimeout(() => void this.persist(), 250);
		}
	}

	private draft(): Record<string, unknown> {
		return { reviewed: [...this.reviewed], range: this.range, selected: this.folders ? [...this.selected] : this.restoredSelection,
			groupOff: [...this.groupOff], itemOff: [...this.itemOff], lookOn: [...this.lookOn],
			agentOff: [...this.agentOff], engineOff: [...this.engineOff], agentOn: [...this.agentOn], agentDefault: this.agentDefault, autonomy: this.autonomy, notifyOn: this.notifyOn, awakeOn: this.awakeOn, vscodeOn: this.vscodeOn,
			vscodeSettingsOff: [...this.vscodeSettingsOff], vscodeExtOff: [...this.vscodeExtOff],
			vscodeKeys: this.vscodeKeys, vscodeSnippets: this.vscodeSnippets };
	}

	async persist(): Promise<void> {
		await this.host.ask('draft', this.draft()).catch(() => undefined);
	}

	private restore(): void {
		const d = this.status?.draft;
		if (!d || this.status?.state === 'done') { return; }
		if (Array.isArray(d.reviewed)) { for (const step of d.reviewed) { if (step === 'projects' || step === 'prefs') { this.reviewed.add(step); } } }
		if (RANGE_OPTIONS.some(r => r.id === d.range)) { this.range = d.range as ExternalRange; }
		this.restoredSelection = Array.isArray(d.selected) ? d.selected.filter((v): v is string => typeof v === 'string') : undefined;
		for (const k of ['groupOff', 'agentOff', 'engineOff', 'agentOn', 'vscodeSettingsOff', 'vscodeExtOff'] as const) {
			if (Array.isArray(d[k])) { this[k] = new Set((d[k] as unknown[]).filter((v): v is string => typeof v === 'string')); }
		}
		for (const k of ['itemOff', 'lookOn'] as const) {
			if (Array.isArray(d[k])) { this[k] = new Set((d[k] as unknown[]).filter((v): v is number => typeof v === 'number')); }
		}
		this.agentDefault = typeof d.agentDefault === 'string' ? d.agentDefault : '';
		this.autonomy = typeof d.autonomy === 'string' ? d.autonomy : '';
		this.notifyOn = d.notifyOn === true;
		this.awakeOn = d.awakeOn !== false;
		this.vscodeOn = d.vscodeOn === true;
		this.vscodeKeys = d.vscodeKeys !== false;
		this.vscodeSnippets = d.vscodeSnippets !== false;
	}

	get stepList(): readonly OnboardingStep[] {
		return onboardingSteps(this.status?.fresh === true, this.requestedStep);
	}

	get fresh(): boolean {
		return this.status?.fresh === true && this.requestedStep !== 'projects' && this.requestedStep !== 'prefs';
	}

	/** Loads the first screen and starts reading the session history. `known`: the status the caller just read. */
	async start(step?: OnboardingStep, known?: IOnboardingStatus): Promise<void> {
		const first = !this.started;
		this.started = true;
		if (step) {
			this.phase = step;
		}
		if (known) {
			this.status = known;
			this.statusError = undefined;
			this.fire();
		} else {
			await this.loadStatus();
		}
		this.requestedStep = step ?? (first ? this.status?.step : this.requestedStep);
		if (first) { this.restore(); }
		const resume = step ?? (this.status?.state === 'done' ? 'agents' : this.status?.step);
		if (resume && STEP_LABEL[resume]) { this.goto(resume); }
		void this.host.ask('scan').catch(e => { this.statusError = String(e); this.fire(); });
		this.poll();
		if (this.status?.vscode && this.vscodeOn) { void this.loadVscode(); }
	}

	async loadVscode(): Promise<void> {
		if (this.vscodeScan || this.vscodeLoading) { return; }
		this.vscodeLoading = true;
		this.vscodeError = undefined;
		this.fire();
		try {
			const result = await this.host.ask<{ found: IOnboardingVscodeScan | null }>('vscode');
			if (!result.found) { throw new Error('VS Code settings are no longer available.'); }
			this.vscodeScan = result.found;
		} catch {
			this.vscodeError = 'Could not read VS Code settings. Check settings.json and retry.';
		} finally {
			this.vscodeLoading = false;
			if (this.phase === 'agents' || this.phase === 'rules') { this.fire(); }
		}
	}

	/** `fresh`: read again even when a read is already on its way (after a sign-in or an install that read would be out of date). */
	async loadStatus(fresh = false): Promise<void> {
		try {
			this.status = await this.host.ask<IOnboardingStatus>('status', fresh ? 'fresh' : undefined);
			this.statusError = undefined;
		} catch (e) {
			this.statusError = String((e as Error)?.message ?? e);
		}
		this.fire();
	}

	private poll(): void {
		this.stopPolling();
		const tick = async () => {
			try {
				const idx = await this.host.ask<IOnboardingStatus['index']>('scan-status');
				if (this.status) {
					this.status = { ...this.status, index: idx };
				}
				if (idx.state === 'interrupted') { this.statusError = 'Reading sessions was interrupted. Retry or skip setup.'; this.fire(); return; }
				if (idx.state === 'done') {
					await this.loadStatus();
					const after = stepAfterHistoryRead(this.fresh, this.phase);
					if (after) { this.goto(after); }
					void this.loadFolders();
					void this.loadPrefs();
					void this.loadRules();
					this.fire();
					return;
				}
				this.fire();
			} catch {
				// the CLI is busy reading: try again
			}
			this.pollTimer = setTimeout(() => void tick(), 1500);
		};
		void tick();
	}

	private stopPolling(): void {
		if (this.pollTimer) {
			clearTimeout(this.pollTimer);
			this.pollTimer = undefined;
		}
	}

	async loadFolders(): Promise<void> {
		if (this.folders || this.status?.index.state !== 'done') {
			return;
		}
		try {
			const res = await this.host.ask<{ rows: IOnboardingFolder[] }>('folders');
			this.folders = res.rows;
			this.selected = this.restoredSelection ? new Set(this.restoredSelection.filter(d => res.rows.some(r => r.dir === d))) : defaultFolderSelection(res.rows, this.range);
			for (const r of res.rows) {
				this.names.set(r.dir, r.name);
			}
		} catch (e) {
			this.statusError = String(e);
		}
		if (this.phase === 'projects' || this.statusError) { this.fire(); }
	}

	async loadPrefs(): Promise<void> {
		if (this.prefs) {
			return;
		}
		try {
			this.prefs = await this.host.ask<IOnboardingPrefs>('prefs');
		} catch (e) {
			this.statusError = String(e);
		}
		if (this.phase === 'prefs' || this.statusError) { this.fire(); }
	}

	async loadRules(): Promise<void> {
		if (this.rules) {
			return;
		}
		try {
			this.rules = await this.host.ask<IOnboardingRules>('rules');
		} catch (e) {
			this.statusError = String(e);
		}
		if (this.phase === 'rules' || this.statusError) { this.fire(); }
	}

	setRange(range: ExternalRange): void {
		this.range = range;
		if (this.folders) {
			this.selected = defaultFolderSelection(this.folders, range);
		}
		this.showAllFolders = false;
		this.fire();
	}

	goto(step: OnboardingStep): void {
		this.phase = step;
		void this.host.ask('step', step).catch(() => undefined);
		if (step === 'projects') {
			void this.loadFolders();
		}
		if (step === 'prefs') {
			void this.loadPrefs();
		}
		if (step === 'rules') {
			void this.loadRules();
		}
		if (step === 'appearance') {
			void this.host.getTheme().then(mode => { this.theme = mode; this.fire(); }, () => undefined);
		}
		this.fire();
	}

	async setTheme(mode: ThemeMode): Promise<void> {
		this.theme = mode;
		this.fire();
		await this.host.setTheme(mode).catch(() => undefined);
	}

	async signIn(id: string): Promise<void> {
		this.signingIn.add(id);
		this.signInMessage = undefined;
		this.fire();
		try {
			const result = await this.host.signIn(id);
			this.signInMessage = result.ok ? undefined : result.message;
		} catch (e) {
			this.signInMessage = String((e as Error)?.message ?? e);
		}
		this.signingIn.delete(id);
		await this.loadStatus(true);
	}

	async addProvider(): Promise<void> {
		this.addingProvider = true;
		this.fire();
		try {
			await this.host.addProvider();
		} catch (e) {
			this.host.notify(String((e as Error)?.message ?? e));
		}
		this.addingProvider = false;
		await this.loadStatus(true);
	}

	async notifyTest(): Promise<void> {
		try {
			this.notifyMessage = (await this.host.notifyTest()).message;
		} catch (e) {
			this.notifyMessage = String((e as Error)?.message ?? e);
		}
		this.fire();
	}

	next(): void {
		if (this.phase === 'projects' || this.phase === 'prefs') { this.reviewed.add(this.phase); }
		const list = this.stepList;
		const i = list.indexOf(this.phase as OnboardingStep);
		if (i >= 0 && i < list.length - 1) {
			this.goto(list[i + 1]);
		}
	}

	back(): void {
		const list = this.stepList;
		const i = list.indexOf(this.phase as OnboardingStep);
		if (i > 0) {
			this.goto(list[i - 1]);
		}
	}

	/** The default as it stands: the one picked by hand, else OpenCode when the other two cannot reach their servers from here. */
	get defaultAgent(): string {
		return wizardDefault(this.agentDefault, this.status?.network, (this.status?.engines ?? []).filter(e => e.installed && !this.engineOff.has(e.id)).map(e => e.id));
	}

	get connectAgents(): ('claude' | 'codex' | 'opencode')[] {
		return (this.rules?.agents ?? []).filter(a => !this.agentOff.has(a.id) && !this.engineOff.has(a.id)).map(a => a.id);
	}

	choices(): ISetupChoices {
		const folders = (this.reviewed.has('projects') ? this.folders ?? [] : []).filter(f => this.selected.has(f.dir)).map(f => ({ dir: f.dir, name: this.names.get(f.dir) ?? f.name }));
		const picks = this.reviewed.has('prefs') && this.prefs ? picksString(prefPicks(this.prefs, this.groupOff, this.itemOff, this.lookOn)) : '';
		let vscode: ISetupChoices['vscode'];
		if (this.vscodeOn && this.vscodeScan) {
			const s = this.vscodeScan;
			vscode = {
				settings: [...s.settings.core, ...s.settings.with_extension.filter(r => !this.vscodeExtOff.has(r.ext))].map(r => r.key).filter(k => !this.vscodeSettingsOff.has(k)),
				keybindings: this.vscodeKeys && s.keybindings.found,
				snippets: this.vscodeSnippets && s.snippets.files.length > 0,
				extensions: s.extensions.install.map(e => e.id).filter(id => !this.vscodeExtOff.has(id)),
			};
		}
		const rows = this.status?.agents;
		return {
			agents: this.connectAgents, range: this.range, folders, picks, use: rows ? wizardChoice(rows, this.engineOff, this.agentOn, this.defaultAgent) : undefined,
			autonomy: this.status?.autonomy ? chosenAutonomy(this.autonomy, this.status.autonomy) : undefined, notify: this.notifyOn, awake: this.awakeOn, vscode,
			gitIdentity: this.gitIdentityChoice(),
		};
	}

	/** What the commits will carry when git has nothing: the person's own words, else a full suggestion; undefined
	 *  when git knows already or nothing is known (agents then ask before their first commit). */
	gitIdentityChoice(): { name: string; email: string } | undefined {
		const g = this.status?.git_identity;
		if (!g || g.known) {
			return undefined;
		}
		const v = this.gitIdentity ?? { name: g.suggest?.name ?? '', email: g.suggest?.email ?? '' };
		return gitIdentityProblem(v.name, v.email) ? undefined : v;
	}

	async changeGitIdentity(): Promise<void> {
		const g = this.status?.git_identity;
		const start = this.gitIdentity ?? { name: g?.suggest?.name ?? '', email: g?.suggest?.email ?? '' };
		const v = await this.host.askGitIdentity(start);
		if (v) {
			this.gitIdentity = v;
			this.fire();
		}
	}

	/** "Set up Dispatch": run everything that was chosen. */
	async run(): Promise<void> {
		const c = this.choices();
		this.steps = setupSteps(c);
		await this.persist();
		this.stopPolling();
		this.failed = [];
		this.phase = 'running';
		this.fire();
		const report = (id: string, state: SetupState, detail?: string) => {
			this.stepState.set(id, { state, detail });
			if (state === 'done') { this.completed.add(id); }
			this.fire();
		};
		const waitIndex = async () => {
			// the history read may still be going on: the steps that need it come after
			await this.host.ask('scan');
			for (let i = 0; i < 1200; i++) {
				const idx = await this.host.ask<IOnboardingStatus['index']>('scan-status');
				if (idx.state === 'done') { return; }
				if (idx.state === 'interrupted') { throw new Error('Reading sessions was interrupted. Retry setup.'); }
				if (this.status) {
					this.status = { ...this.status, index: idx };
				}
				this.fire();
				await new Promise(r => setTimeout(r, 1500));
			}
			throw new Error('Reading sessions timed out. Retry setup.');
		};
		this.failed = await runSetup(this.host, c, report, waitIndex, this.completed);
		if (!this.failed.length) {
			try { await this.host.ask('finish'); } catch (e) { this.failed.push('finish'); this.host.notify(String(e)); }
		}
		this.phase = 'finished';
		this.fire();
	}

	async skip(): Promise<void> {
		await this.persist();
		this.stopPolling();
		try {
			await this.host.ask('skip');
		} catch {
			// nothing to keep
		}
		this.host.leave(false);
	}

	async installEngine(id: string): Promise<void> {
		this.installing.add(id);
		this.fire();
		try {
			await this.host.installEngine(id);
		} catch (e) {
			this.host.notify(localize('dispatchOnboarding.installFailed', "Could not install: {0}", String((e as Error)?.message ?? e)));
		}
		this.installing.delete(id);
		await this.loadStatus(true);
		this.rules = undefined;
		void this.loadRules();
	}
}

// ---- the page --------------------------------------------------------------------------------------

function icon(name: string): HTMLElement {
	return $(`span.codicon.codicon-${name}`);
}

/** An agent's own mark (dispatchAgentIcons.ts): every agent row shows it, never a generic icon. */
function agentGlyph(id: string): HTMLElement {
	return $(`span.dob-gl${ThemeIcon.asCSSSelector(agentIcon(id))}`);
}

export class OnboardingPage extends Disposable {

	private root: HTMLElement | undefined;
	private pointerDown = false;
	private redrawPending = false;
	private releaseTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly store = this._register(new DisposableStore());
	private readonly scrolls = new Map<string, number>();

	constructor(private readonly c: OnboardingController, private readonly contextViewService: IContextViewService) {
		super();
		this._register(c.onDidChange(() => this.draw()));
	}

	get description(): string {
		const list = this.c.stepList;
		if (this.c.phase === 'running' || this.c.phase === 'finished') {
			return localize('dispatchOnboarding.settingUp', "Setting up");
		}
		const i = Math.max(0, list.indexOf(this.c.phase as OnboardingStep));
		return localize('dispatchOnboarding.stepOf', "{0} of {1} · {2}", i + 1, list.length, STEP_LABEL[this.c.phase as OnboardingStep] ?? '');
	}

	render(container: HTMLElement): void {
		this.root = DOM.append(container, $('.dispatch-onboarding'));
		this._register(DOM.addDisposableListener(this.root, DOM.EventType.MOUSE_DOWN, e => { if (e.button === 0) { this.pointerDown = true; } }, true));
		const release = () => {
			if (this.releaseTimer) { clearTimeout(this.releaseTimer); }
			// The click follows mouseup. Keep its target mounted until both events were delivered.
			this.releaseTimer = setTimeout(() => {
				this.pointerDown = false;
				if (this.redrawPending && this.root?.isConnected) { this.redrawPending = false; this.draw(); }
			}, 0);
		};
		this._register(DOM.addDisposableListener(this.root.ownerDocument, DOM.EventType.MOUSE_UP, release, true));
		this._register(DOM.addDisposableListener(this.root.ownerDocument.defaultView!, 'blur', release));
		this._register(toDisposable(() => { if (this.releaseTimer) { clearTimeout(this.releaseTimer); } }));
		this.draw();
	}

	layout(height: number): void {
		if (this.root) {
			this.root.style.height = `${Math.max(320, height - 20)}px`;
		}
	}

	focus(): void {
		this.root?.querySelector<HTMLElement>('.dob-btn.fill')?.focus();
	}

	// ---- structure

	private draw(): void {
		if (this.pointerDown) { this.redrawPending = true; return; }
		const root = this.root;
		if (!root) {
			return;
		}
		for (const el of root.querySelectorAll<HTMLElement>('[data-scroll]')) {
			this.scrolls.set(el.dataset.scroll!, el.scrollTop);
		}
		const active = root.contains(DOM.getActiveElement()) ? DOM.getActiveElement()?.getAttribute('aria-label') : null;
		if (active) { queueMicrotask(() => { [...root.querySelectorAll<HTMLElement>('[aria-label]')].find(el => el.getAttribute('aria-label') === active)?.focus(); }); }
		this.store.clear();
		DOM.clearNode(root);
		const c = this.c;
		if (c.statusError) {
			this.frame(root, localize('dispatchOnboarding.errTitle', "Set up Dispatch"), c.statusError, undefined, [this.button(localize('dispatchOnboarding.retry', "Retry"), 'fill', () => { c.statusError = undefined; void c.start(c.phase as OnboardingStep); }), this.button(localize('dispatchOnboarding.skip', "Skip setup"), 'ghost', () => void c.skip())]);
			return;
		}
		if (!c.status) {
			this.frame(root, localize('dispatchOnboarding.looking', "Looking at this Mac"), localize('dispatchOnboarding.lookingSub', "It only takes a moment."), $('.dob-skeleton'), []);
			return;
		}
		switch (c.phase) {
			case 'agents': return this.agentsScreen(root);
			case 'projects': return this.projectsScreen(root);
			case 'prefs': return this.prefsScreen(root);
			case 'autonomy': return this.autonomyScreen(root);
			case 'appearance': return this.appearanceScreen(root);
			case 'notifications': return this.notificationsScreen(root);
			case 'rules': return this.rulesScreen(root);
			default: return this.runScreen(root);
		}
		// scroll positions are put back by the screens (see keepScroll)
	}

	private frame(root: HTMLElement, title: string, sub: string, body: HTMLElement | undefined, foot: HTMLElement[], step?: number, total?: number): void {
		const bars = DOM.append(root, $('.dob-bars', { role: 'progressbar', 'aria-label': 'Setup steps' }));
		const list = this.c.stepList;
		const n = total ?? list.length;
		const at = step ?? (this.c.phase === 'running' || this.c.phase === 'finished' ? n : 0);
		bars.setAttribute('aria-valuemin', '1');
		bars.setAttribute('aria-valuemax', String(n));
		bars.setAttribute('aria-valuenow', String(Math.max(1, at)));
		for (let i = 0; i < n; i++) {
			DOM.append(bars, $(`i${i < at ? '.on' : ''}`));
		}
		DOM.append(root, $('h2.dob-title', undefined, title));
		DOM.append(root, $('p.dob-sub', undefined, sub));
		const b = DOM.append(root, $('.dob-body'));
		if (body) {
			b.appendChild(body);
		}
		const f = DOM.append(root, $('.dob-foot'));
		const left = foot.filter(x => !x.classList.contains('fill'));
		const right = foot.filter(x => x.classList.contains('fill'));
		for (const x of left) {
			f.appendChild(x);
		}
		DOM.append(f, $('span.dob-sp'));
		for (const x of right) {
			f.appendChild(x);
		}
	}

	private keepScroll(el: HTMLElement, key: string): void {
		el.dataset.scroll = key;
		const y = this.scrolls.get(key);
		if (y) {
			queueMicrotask(() => { el.scrollTop = y; });
		}
	}

	private button(label: string, kind: 'fill' | 'ghost' | 'plain' | 'xs', run: () => void, disabled = false): HTMLElement {
		const button = this.store.add(new Button($('div'), { ...defaultButtonStyles, secondary: kind !== 'fill', ariaLabel: label }));
		button.label = label;
		button.enabled = !disabled;
		button.element.classList.add('dob-btn', kind);
		this.store.add(button.onDidClick(() => { if (!disabled) { run(); } }));
		return button.element;
	}

	private checkbox(state: boolean | 'mixed', label: string, onToggle: () => void, disabled = false): HTMLElement {
		const cb = this.store.add(new Checkbox(label, state === true, { ...defaultCheckboxStyles, size: 16 }));
		cb.domNode.classList.add('dob-cb');
		cb.domNode.setAttribute('aria-label', label);
		if (state === 'mixed') { cb.domNode.setAttribute('aria-checked', 'mixed'); cb.domNode.classList.add('codicon', 'codicon-dash'); }
		if (disabled) { cb.disable(); }
		this.store.add(DOM.addDisposableListener(cb.domNode, DOM.EventType.CLICK, e => e.stopPropagation()));
		this.store.add(cb.onChange(() => { if (!disabled) { onToggle(); } }));
		return cb.domNode;
	}

	private groupHead(parent: HTMLElement, label: string, count?: string | number): void {
		const h = DOM.append(parent, $('.dob-gh'));
		DOM.append(h, $('span', undefined, label));
		if (count !== undefined) {
			DOM.append(h, $('span.ct', undefined, String(count)));
		}
	}

	private well(parent: HTMLElement, fill = false): HTMLElement {
		return DOM.append(parent, $(`.dob-well${fill ? '.fill' : ''}`));
	}

	private skipButton(): HTMLElement {
		return this.button(localize('dispatchOnboarding.skip', "Skip setup"), 'ghost', () => void this.c.skip());
	}

	private backButton(): HTMLElement {
		return this.button(localize('dispatchOnboarding.back', "Back"), 'ghost', () => this.c.back());
	}

	// ---- 1 Agents

	private engineRow(well: HTMLElement, e: IOnboardingEngine): void {
		const c = this.c;
		const row = DOM.append(well, $('.dob-row.with-why'));
		const about = (c.status?.agents ?? []).find(a => a.id === e.id)?.about ?? '';
		if (!e.installed) {
			row.appendChild(this.checkbox(false, e.name, () => { }, true));
			DOM.append(row, agentGlyph(e.id));
			const idle = DOM.append(row, $('.dob-main'));
			DOM.append(DOM.append(idle, $('.dob-line')), $('span.dob-n.mut', undefined, e.name));
			DOM.append(idle, $('.dob-why', undefined, e.install || !e.install_why
				? localize('dispatchOnboarding.installWhy', "{0} Installing adds it to this Mac so Dispatch can start sessions with it.", about)
				: `${about} ${e.install_why}`));
			const r = DOM.append(row, $('.dob-r'));
			DOM.append(r, $('span', undefined, localize('dispatchOnboarding.notInstalled', "Not installed")));
			if (e.install) {
				const busy = c.installing.has(e.id);
				const b = this.button(busy ? localize('dispatchOnboarding.installing', "Installing...") : localize('dispatchOnboarding.install', "Install"), 'xs', () => void c.installEngine(e.id), busy);
				b.title = localize('dispatchOnboarding.installTip', "Install {0} on this Mac", e.name);
				r.appendChild(b);
			}
			return;
		}
		const on = !c.engineOff.has(e.id);
		row.appendChild(this.checkbox(on, localize('dispatchOnboarding.useAgent', "Use {0} with Dispatch", e.name), () => { on ? c.engineOff.add(e.id) : c.engineOff.delete(e.id); c.fire(); }));
		DOM.append(row, agentGlyph(e.id));
		const main = DOM.append(row, $('.dob-main'));
		const line = DOM.append(main, $('.dob-line'));
		DOM.append(line, $('span.dob-n', undefined, e.name));
		if (e.version) {
			DOM.append(line, $('span.dob-p', undefined, e.version));
		}
		if (about) {
			DOM.append(main, $('.dob-why', undefined, about));
		}
		const r = DOM.append(row, $('.dob-r'));
		if (on) {
			const here = c.status!.engines.filter(x => x.installed && !c.engineOff.has(x.id)).map(x => x.id);
			if (effectiveDefault(here, c.defaultAgent) === e.id) {
				DOM.append(r, $('span.dob-tag', undefined, localize('dispatchOnboarding.default', "Default")));
			} else {
				const set = this.button(localize('dispatchOnboarding.setDefault', "Set default"), 'xs', () => { c.agentDefault = e.id; c.fire(); });
				set.title = localize('dispatchOnboarding.setDefaultTip', "New sessions start with {0}", e.name);
				r.appendChild(set);
			}
		}
		if ((e.id === 'claude' || e.id === 'codex') && e.account === 'Not signed in') {
			const busy = c.signingIn.has(e.id);
			const b = this.button(busy ? localize('dispatchOnboarding.signingIn', "Waiting for the browser...") : localize('dispatchOnboarding.signIn', "Sign in"), 'xs', () => void c.signIn(e.id), busy);
			b.title = localize('dispatchOnboarding.signInTip', "Opens {0}'s sign-in page in your browser", e.name);
			r.appendChild(b);
		}
		const noProvider = e.id === 'opencode' && e.account === 'No provider set up';
		if (noProvider) {
			// the button says it: "No provider set up" next to it would only squeeze the description
			const busy = c.addingProvider;
			const b = this.button(busy ? localize('dispatchOnboarding.addingProvider', "Adding in the terminal...") : localize('dispatchOnboarding.addProvider', "Add provider"), 'xs', () => void c.addProvider(), busy);
			b.title = localize('dispatchOnboarding.addProviderTip', "No AI service is set up for OpenCode yet. This opens a terminal below, where OpenCode asks which one you use and its key. Without one, OpenCode's free models work.");
			r.appendChild(b);
		} else {
			DOM.append(r, $('span', undefined, e.account));
		}
		const idx = c.status!.index;
		// a new Mac has no earlier sessions anywhere, and the page's first line says so already
		if (e.sessions !== null && idx.state !== 'running' && !(c.fresh && e.sessions === 0)) {
			DOM.append(r, $('span', undefined, e.sessions === 0 ? localize('dispatchOnboarding.noSessions', "No earlier sessions") : localize('dispatchOnboarding.sessions', "{0} {1}", e.sessions, plural(e.sessions, 'session', 'sessions'))));
		} else if (idx.state === 'running') {
			DOM.append(r, $('span.dob-shim'));
		}
	}

	/** An agent CLI Dispatch cannot start sessions with yet: found on this Mac, off until ticked. */
	private otherAgentRow(well: HTMLElement, a: IAgentRow): void {
		const c = this.c;
		const row = DOM.append(well, $('.dob-row.with-why'));
		const on = c.agentOn.has(a.id);
		row.appendChild(this.checkbox(on, localize('dispatchOnboarding.useAgent', "Use {0} with Dispatch", a.name), () => { on ? c.agentOn.delete(a.id) : c.agentOn.add(a.id); c.fire(); }));
		DOM.append(row, agentGlyph(a.id));
		const main = DOM.append(row, $('.dob-main'));
		const line = DOM.append(main, $('.dob-line'));
		DOM.append(line, $('span.dob-n', undefined, a.name));
		if (a.version) {
			DOM.append(line, $('span.dob-p', undefined, a.version));
		}
		DOM.append(main, $('.dob-why', undefined, a.about));
		const r = DOM.append(row, $('.dob-r'));
		if (a.account) {
			DOM.append(r, $('span', undefined, a.account));
		}
		row.title = NOT_RUNNABLE;
	}

	private agentsScreen(root: HTMLElement): void {
		const c = this.c, s = c.status!;
		const others = (s.agents ?? []).filter(a => !a.runnable && a.installed);
		const installed = [...s.engines.filter(e => e.installed), ...others];
		const reading = s.index.state === 'running';
		const fresh = c.fresh;
		const total = s.history.sessions ?? 0;
		const sub = fresh
			? localize('dispatchOnboarding.subFresh', "Dispatch works with the coding agents you already use. Nothing to bring over yet, so you start fresh.")
			: reading
				? localize('dispatchOnboarding.subReading', "Dispatch works with the coding agents you already use. It found {0} of them and is reading their earlier sessions in the background.", installed.length)
				: total
					? localize('dispatchOnboarding.subFound', "Dispatch works with the coding agents you already use. It found {0} of them and {1} earlier sessions.", installed.length, total)
					: localize('dispatchOnboarding.subNone', "Dispatch works with the coding agents you already use.");
		const body = $('.dob-scroll');
		this.keepScroll(body, 'agents');
		this.groupHead(body, localize('dispatchOnboarding.agentsHere', "Agents on this Mac"), `${installed.length}${installed.length < s.engines.length && !others.length ? ` of ${s.engines.length}` : ''}`);
		const well = this.well(body);
		for (const e of s.engines) {
			this.engineRow(well, e);
		}
		if (c.signInMessage) {
			DOM.append(body, $('p.dob-note', { role: 'alert' }, c.signInMessage));
		}
		appendWizardNetwork(body, s.network, s.engines.some(e => e.id === 'opencode' && e.installed), {
			groupHead: (p, label, count) => this.groupHead(p, label, count), well: p => this.well(p), button: (label, kind, run, disabled) => this.button(label, kind, run, disabled),
		});
		if (others.length) {
			this.groupHead(body, localize('dispatchOnboarding.otherAgents', "Other agents found"), others.length);
			DOM.append(body, $('p.dob-note', undefined, localize('dispatchOnboarding.otherAgentsNote', "Dispatch cannot start sessions with these yet. Tick one to keep it in your list.")));
			const w3 = this.well(body);
			for (const a of others) {
				this.otherAgentRow(w3, a);
			}
		}
		if (reading) {
			const pr = DOM.append(body, $('.dob-progress'));
			const line = DOM.append(pr, $('.dob-row.plain'));
			DOM.append(line, $('span.dob-spin'));
			DOM.append(line, $('.dob-main', undefined, $('span.dob-n.reg', undefined, localize('dispatchOnboarding.reading', "Reading earlier sessions"))));
			const idx = s.index;
			if (idx.total) {
				DOM.append(line, $('.dob-r', undefined, $('span', undefined, idx.done !== null ? localize('dispatchOnboarding.readingCount', "{0} of {1} files", idx.done.toLocaleString(), idx.total.toLocaleString()) : localize('dispatchOnboarding.readingTotal', "{0} files", idx.total.toLocaleString()))));
			}
			const bar = DOM.append(pr, $('.dob-pbar'));
			const fill = DOM.append(bar, $('i'));
			if (idx.done !== null && idx.total) {
				fill.style.width = `${Math.min(100, Math.round(idx.done / idx.total * 100))}%`;
			} else {
				bar.classList.add('busy');
			}
		}
		if (s.others.length) {
			DOM.append(body, $('p.dob-note', undefined, localize('dispatchOnboarding.others', "Also here and left alone: {0}. Dispatch does not run them yet, so it does not touch their files.", s.others.join(', '))));
		}
		if (s.vscode) {
			this.groupHead(body, localize('dispatchOnboarding.editors', "Other editors"), 1);
			const w2 = this.well(body);
			const row = DOM.append(w2, $('.dob-row'));
			row.appendChild(this.checkbox(c.vscodeOn, localize('dispatchOnboarding.vscodeUse', "Import from VS Code"), () => { c.vscodeOn = !c.vscodeOn; if (c.vscodeOn) { void c.loadVscode(); } c.fire(); }));
			DOM.append(row, $('span.dob-gl.codicon.codicon-vscode'));
			const main = DOM.append(row, $('.dob-main'));
			DOM.append(main, $('span.dob-n', undefined, 'VS Code'));
			DOM.append(main, $('span.dob-p', undefined, ` ${localize('dispatchOnboarding.vscodeFound', "{0} settings · {1} extensions found", s.vscode.settings_total, s.vscode.extensions_total)}`));
			const r = DOM.append(row, $('.dob-r'));
			r.appendChild(this.button(localize('dispatchOnboarding.choose', "Choose"), 'xs', () => { c.vscodeOn = true; c.vscodeSheet = true; void c.loadVscode(); c.fire(); }));
		}
		const priv = DOM.append(body, $('p.dob-note.lock'));
		DOM.append(priv, icon('lock'));
		DOM.append(priv, $('span', undefined, localize('dispatchOnboarding.private', "Everything stays on this Mac. Dispatch reads these folders and sends nothing to a model. It also sets up its task board here; there is nothing to configure.")));
		if (c.vscodeSheet) {
			if (c.vscodeScan) { return this.vscodeScreen(root); }
			const loading = $('.dob-scroll');
			DOM.append(loading, $('p.dob-note', { role: 'status' }, c.vscodeError ?? 'Checking VS Code settings and extensions...'));
			return this.frame(root, 'Take your settings and extensions', 'Choose what to bring from VS Code.', loading, [
				this.button('Back', 'ghost', () => { c.vscodeSheet = false; c.fire(); }),
				...(c.vscodeError ? [this.button('Retry', 'fill', () => void c.loadVscode())] : []),
			], 1);
		}
		if (c.vscodeOn && !c.vscodeScan) { DOM.append(body, $('p.dob-note', { role: 'status' }, c.vscodeError ?? 'Checking VS Code settings and extensions...')); }
		this.frame(root, localize('dispatchOnboarding.welcome', "Welcome to Dispatch"), sub, body, [
			this.skipButton(),
			this.button(localize('dispatchOnboarding.continue', "Continue"), 'fill', () => c.next(), c.vscodeOn && !c.vscodeScan),
		], 1);
	}

	// ---- VS Code

	private vscodeScreen(root: HTMLElement): void {
		const c = this.c, v = c.vscodeScan!;
		DOM.clearNode(root);
		const body = $('.dob-scroll');
		this.keepScroll(body, 'vscode');
		const settings = [...v.settings.core.map(r => ({ key: r.key, note: '', ext: '' })), ...v.settings.with_extension.map(r => ({ key: r.key, note: localize('dispatchOnboarding.withExt', "with {0}", r.with), ext: r.ext }))];
		this.groupHead(body, localize('dispatchOnboarding.settings', "Settings"), localize('dispatchOnboarding.settingsCount', "{0} of {1} can come along", settings.length, v.settings.total));
		const w1 = this.well(body);
		for (const st of settings) {
			const dependencyOff = !!st.ext && c.vscodeExtOff.has(st.ext);
			const off = dependencyOff || c.vscodeSettingsOff.has(st.key);
			const row = DOM.append(w1, $('.dob-row.tight'));
			row.appendChild(this.checkbox(!off, st.key, () => { off ? c.vscodeSettingsOff.delete(st.key) : c.vscodeSettingsOff.add(st.key); c.fire(); }, dependencyOff));
			DOM.append(row, $('.dob-main', undefined, $('span.dob-n.mono', undefined, st.key)));
			DOM.append(row, $('.dob-r', undefined, $('span', undefined, st.note)));
		}
		for (const sk of v.settings.skip) {
			const row = DOM.append(w1, $('.dob-row.tight'));
			row.appendChild(this.checkbox(false, sk.key, () => { }, true));
			DOM.append(row, $('.dob-main', undefined, $('span.dob-n.mono.mut', undefined, sk.key)));
			DOM.append(row, $('.dob-r', undefined, $('span', undefined, sk.why)));
		}
		this.groupHead(body, localize('dispatchOnboarding.shortcuts', "Keyboard shortcuts and snippets"), v.keybindings.found || v.snippets.files.length ? undefined : localize('dispatchOnboarding.noneFound', "none found"));
		if (v.keybindings.found || v.snippets.files.length) {
			const w = this.well(body);
			if (v.keybindings.found) {
				const row = DOM.append(w, $('.dob-row.tight'));
				row.appendChild(this.checkbox(c.vscodeKeys, 'keybindings', () => { c.vscodeKeys = !c.vscodeKeys; c.fire(); }));
				DOM.append(row, $('.dob-main', undefined, $('span.dob-n.reg', undefined, localize('dispatchOnboarding.keybindings', "Keyboard shortcuts ({0})", v.keybindings.count))));
			}
			if (v.snippets.files.length) {
				const row = DOM.append(w, $('.dob-row.tight'));
				row.appendChild(this.checkbox(c.vscodeSnippets, 'snippets', () => { c.vscodeSnippets = !c.vscodeSnippets; c.fire(); }));
				DOM.append(row, $('.dob-main', undefined, $('span.dob-n.reg', undefined, localize('dispatchOnboarding.snippets', "Snippets ({0} files)", v.snippets.files.length))));
			}
		}
		const e = v.extensions;
		this.groupHead(body, localize('dispatchOnboarding.extensions', "Extensions"), localize('dispatchOnboarding.extCount', "{0} found · {1} can be installed", e.total, e.install.length));
		const w3 = this.well(body);
		for (const x of e.install) {
			const off = c.vscodeExtOff.has(x.id);
			const row = DOM.append(w3, $('.dob-row.tight'));
			row.appendChild(this.checkbox(!off, x.name, () => { off ? c.vscodeExtOff.delete(x.id) : c.vscodeExtOff.add(x.id); c.fire(); }));
			DOM.append(row, $('.dob-main', undefined, $('span.dob-n.reg', undefined, x.name), $('span.dob-p', undefined, ` ${x.id}`)));
		}
		const left = [...e.missing.map(x => ({ ...x })), ...e.builtin, ...e.theme, ...e.tweak];
		if (left.length) {
			const g = DOM.append(body, $('p.dob-note', undefined, localize('dispatchOnboarding.notImported', "Not imported: {0}.", left.map(x => `${x.name} (${x.why})`).join(', '))));
			g.classList.add('small');
		}
		const n = c.stepList.length;
		this.frame(root, localize('dispatchOnboarding.vscodeTitle', "Take your settings and extensions"), localize('dispatchOnboarding.vscodeSub', "Copied from VS Code. A copy of your Dispatch IDE settings is kept for Undo."), body, [
			this.button(localize('dispatchOnboarding.back', "Back"), 'ghost', () => { c.vscodeSheet = false; c.fire(); }),
			this.button(localize('dispatchOnboarding.vscodeDone', "Done"), 'fill', () => { c.vscodeSheet = false; c.vscodeOn = true; c.fire(); }),
		], 1, n);
	}

	// ---- 2 Projects

	private projectsScreen(root: HTMLElement): void {
		const c = this.c;
		const rows = c.folders;
		const idxRunning = c.status!.index.state === 'running';
		if (!rows) {
			const body = $('.dob-well.fill');
			const list = DOM.append(body, $('.dob-listhead'));
			DOM.append(list, $('span.dob-spin'));
			DOM.append(list, $('span.dob-n.reg', undefined, localize('dispatchOnboarding.reading', "Reading earlier sessions")));
			const idx = c.status!.index;
			if (idx.total) {
				DOM.append(list, $('span.dob-r', undefined, idx.done !== null ? localize('dispatchOnboarding.readingCount', "{0} of {1} files", idx.done.toLocaleString(), idx.total.toLocaleString()) : localize('dispatchOnboarding.readingTotal', "{0} files", idx.total.toLocaleString())));
			}
			const sk = DOM.append(body, $('.dob-skel'));
			for (let i = 0; i < 9; i++) {
				DOM.append(sk, $('.dob-row.tight', undefined, $('span.dob-cb.disabled'), $('span.dob-shim', { style: `width:${90 + (i * 37) % 80}px` }), $('span.dob-shim.soft', { style: `width:${180 + (i * 53) % 120}px` })));
			}
			const wrap = $('.dob-fill');
			wrap.appendChild(body);
			DOM.append(wrap, $('p.dob-note', undefined, localize('dispatchOnboarding.firstRead', "The first read takes a few minutes. You can wait here or skip and add folders later from Projects.")));
			return this.frame(root, localize('dispatchOnboarding.foldersTitle', "Bring your folders in as projects"), localize('dispatchOnboarding.foldersReading', "Dispatch is still reading what your agents did. The list fills in as it goes."), wrap, [
				this.skipButton(), this.backButton(), this.button(localize('dispatchOnboarding.addProjects', "Add projects"), 'fill', () => { }, true),
			], c.stepList.indexOf('projects') + 1);
		}
		const days = rangeDays(c.range);
		const counts = folderCounts(rows, c.range, c.selected);
		const inRange = rows.filter(r => r.days <= days);
		const older = rows.filter(r => r.days > days);
		const rangeLabel = RANGE_OPTIONS.find(r => r.id === c.range)!.label;
		const wrap = $('.dob-fill');
		const well = this.well(wrap, true);
		const head = DOM.append(well, $('.dob-listhead'));
		const state: boolean | 'mixed' = counts.selectedIn === 0 ? false : counts.selectedIn === counts.inRange ? true : 'mixed';
		head.appendChild(this.checkbox(state, localize('dispatchOnboarding.selectAll', "Select all in range"), () => {
			const all = inRange.every(r => c.selected.has(r.dir));
			for (const r of inRange) {
				all ? c.selected.delete(r.dir) : c.selected.add(r.dir);
			}
			c.fire();
		}));
		DOM.append(head, $('span.dob-n.reg', undefined, localize('dispatchOnboarding.selectedCount', "{0} of {1} selected{2}", counts.selectedIn, counts.inRange, counts.selectedOlder ? localize('dispatchOnboarding.plusOlder', " + {0} older", counts.selectedOlder) : '')));
		DOM.append(head, $('span.dob-sp'));
		const selectContainer = DOM.append(head, $('.dob-range'));
		const select = this.store.add(new SelectBox(RANGE_OPTIONS.map(o => ({ text: o.label })), RANGE_OPTIONS.findIndex(o => o.id === c.range), this.contextViewService, defaultSelectBoxStyles, { useCustomDrawn: true, ariaLabel: 'External sessions time range' }));
		select.render(selectContainer);
		this.store.add(select.onDidSelect(e => {
			c.setRange(RANGE_OPTIONS[e.index].id);
			queueMicrotask(() => this.root?.querySelector<HTMLElement>('.dob-range select')?.focus());
		}));

		const list = DOM.append(well, $('.dob-list'));
		this.keepScroll(list, 'projects');
		const shown = c.showAllFolders ? inRange : inRange.slice(0, FIRST_ROWS);
		for (const r of shown) {
			this.folderRow(list, r);
		}
		if (inRange.length > shown.length) {
			const more = DOM.append(list, $('button.dob-more', { type: 'button' }, localize('dispatchOnboarding.showMore', "Show {0} more", inRange.length - shown.length)));
			this.store.add(DOM.addDisposableListener(more, DOM.EventType.CLICK, () => { c.showAllFolders = true; c.fire(); }));
		}
		if (!inRange.length) {
			DOM.append(list, $('.dob-empty', undefined, localize('dispatchOnboarding.noneInRange', "No folder in this range. Pick a longer one, or look at the older ones below.")));
		}
		if (older.length) {
			const h = DOM.append(list, $('button.dob-oldhead', { type: 'button' }));
			DOM.append(h, icon(c.olderOpen ? 'chevron-down' : 'chevron-right'));
			DOM.append(h, $('span', undefined, localize('dispatchOnboarding.older', "Older than {0}", rangeLabel.replace('Last ', '').toLowerCase())));
			DOM.append(h, $('span.ct', undefined, localize('dispatchOnboarding.olderCount', "{0} · not ticked, add any you want", older.length)));
			this.store.add(DOM.addDisposableListener(h, DOM.EventType.CLICK, () => { c.olderOpen = !c.olderOpen; c.fire(); }));
			if (c.olderOpen) {
				for (const r of older) {
					this.folderRow(list, r);
				}
			}
		}
		const n = counts.selectedIn + counts.selectedOlder;
		DOM.append(wrap, $('p.dob-note', undefined, localize('dispatchOnboarding.foldersNote', "{0} earlier sessions will show under their project in the sidebar. Folders without git get git init; nothing else in them changes.", counts.sessions)));
		const sub = localize('dispatchOnboarding.foldersSub', "Your agents worked in {0} folders. The ones you used in the {1} are ticked, unless something looks off.", rows.length, rangeLabel.toLowerCase());
		this.frame(root, localize('dispatchOnboarding.foldersTitle', "Bring your folders in as projects"), idxRunning ? localize('dispatchOnboarding.foldersStill', "Still reading: more folders may show up.") : sub, wrap, [
			this.skipButton(), this.backButton(),
			this.button(n ? localize('dispatchOnboarding.addN', "Add {0} {1}", n, plural(n, 'project', 'projects')) : localize('dispatchOnboarding.continue', "Continue"), 'fill', () => c.next()),
		], c.stepList.indexOf('projects') + 1);
	}

	private folderRow(list: HTMLElement, r: IOnboardingFolder): void {
		const c = this.c;
		const on = c.selected.has(r.dir);
		const row = DOM.append(list, $('.dob-row.folder'));
		const reasoned = !!r.reason && !on;
		row.classList.toggle('with-why', reasoned);
		row.appendChild(this.checkbox(on, r.name, () => { on ? c.selected.delete(r.dir) : c.selected.add(r.dir); c.fire(); }));
		const main = DOM.append(row, $('.dob-main'));
		const line = DOM.append(main, $('.dob-line'));
		DOM.append(line, $('span.dob-n', undefined, r.name));
		DOM.append(line, $('span.dob-p', undefined, pathLabel(r.display)));
		if (reasoned) {
			DOM.append(main, $('.dob-why', undefined, r.reason));
		}
		const right = DOM.append(row, $('.dob-r'));
		if (on && !r.git) {
			DOM.append(right, $('span.dob-tag', undefined, 'git init'));
		}
		DOM.append(right, $('span', undefined, localize('dispatchOnboarding.sessions', "{0} {1}", r.sessions, plural(r.sessions, 'session', 'sessions'))));
		DOM.append(right, $('span.age', undefined, ageLabel(r.days)));
		this.store.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, e => { if ((e.target as HTMLElement).closest('.dob-cb')) { return; } on ? c.selected.delete(r.dir) : c.selected.add(r.dir); c.fire(); }));
	}


	// ---- 3 Preferences

	private prefsScreen(root: HTMLElement): void {
		const c = this.c;
		const plan = c.prefs;
		const stepNo = c.stepList.indexOf('prefs') + 1;
		if (!plan) {
			const w = $('.dob-well.fill');
			DOM.append(w, $('.dob-listhead', undefined, $('span.dob-spin'), $('span.dob-n.reg', undefined, localize('dispatchOnboarding.readingPrefs', "Reading your rules files and the agents' memory"))));
			return this.frame(root, localize('dispatchOnboarding.prefsTitle', "Bring your preferences"), localize('dispatchOnboarding.prefsWait', "This takes a moment."), w, [this.skipButton(), this.backButton(), this.button(localize('dispatchOnboarding.continue', "Continue"), 'fill', () => c.next(), true)], stepNo);
		}
		const picks = prefPicks(plan, c.groupOff, c.itemOff, c.lookOn).length;
		const wrap = $('.dob-fill');
		const well = this.well(wrap, true);
		const head = DOM.append(well, $('.dob-listhead'));
		const total = plan.clear + plan.look;
		// the header box is the whole list, the ones to look at included: all ticked is "N of N"
		const state: boolean | 'mixed' = picks === 0 ? false : picks === total ? true : 'mixed';
		head.appendChild(this.checkbox(state, localize('dispatchOnboarding.selectAllPrefs', "Select all preferences"), () => {
			if (picks === total) {
				for (const g of plan.groups) {
					c.groupOff.add(g.id);
				}
				c.lookOn.clear();
			} else {
				c.groupOff.clear();
				c.itemOff.clear();
				for (const it of plan.look_items) {
					c.lookOn.add(it.n);
				}
			}
			c.fire();
		}));
		DOM.append(head, $('span.dob-n.reg', undefined, localize('dispatchOnboarding.prefsSelected', "{0} of {1} selected", picks, total)));
		DOM.append(head, $('span.dob-sp'));
		DOM.append(head, $('span.dob-p', undefined, plan.sources));
		const list = DOM.append(well, $('.dob-list'));
		this.keepScroll(list, 'prefs');
		for (const g of plan.groups) {
			const open = c.groupOpen.has(g.id);
			const off = c.groupOff.has(g.id);
			const row = DOM.append(list, $('.dob-row.group'));
			row.appendChild(this.checkbox(!off, g.name, () => { off ? c.groupOff.delete(g.id) : c.groupOff.add(g.id); c.fire(); }));
			DOM.append(row, icon(open ? 'chevron-down' : 'chevron-right'));
			DOM.append(row, $('span.dob-n', undefined, g.name));
			DOM.append(row, $('span.dob-p', undefined, String(g.n)));
			DOM.append(row, $('.dob-r', undefined, $('span', undefined, localize('dispatchOnboarding.likeAvoid', "{0} Like · {1} Avoid", g.like, g.avoid))));
			this.store.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => { open ? c.groupOpen.delete(g.id) : c.groupOpen.add(g.id); c.fire(); }));
			if (open) {
				const items = c.groupAll.has(g.id) ? g.items : g.items.slice(0, FIRST_ITEMS);
				for (const it of items) {
					this.prefRow(list, it, !off && !c.itemOff.has(it.n), () => { c.itemOff.has(it.n) ? c.itemOff.delete(it.n) : c.itemOff.add(it.n); if (off) { c.groupOff.delete(g.id); for (const o of g.items) { if (o.n !== it.n) { c.itemOff.add(o.n); } } c.itemOff.delete(it.n); } c.fire(); });
				}
				if (g.items.length > items.length) {
					const more = DOM.append(list, $('button.dob-more.indent', { type: 'button' }, localize('dispatchOnboarding.showMore', "Show {0} more", g.items.length - items.length)));
					this.store.add(DOM.addDisposableListener(more, DOM.EventType.CLICK, () => { c.groupAll.add(g.id); c.fire(); }));
				}
			} else {
				DOM.append(list, $('.dob-peek', undefined, g.items.slice(0, 2).map(i => i.text).join(' · ')));
			}
		}
		if (plan.look) {
			const row = DOM.append(list, $('.dob-row.group.look'));
			row.appendChild(this.checkbox(c.lookOn.size === 0 ? false : c.lookOn.size === plan.look_items.length ? true : 'mixed', 'to look at', () => {
				if (c.lookOn.size === plan.look_items.length) {
					c.lookOn.clear();
				} else {
					for (const it of plan.look_items) {
						c.lookOn.add(it.n);
					}
				}
				c.fire();
			}));
			DOM.append(row, icon(c.lookOpen ? 'chevron-down' : 'chevron-right'));
			DOM.append(row, $('span.dob-n', undefined, localize('dispatchOnboarding.lookAt', "To look at")));
			DOM.append(row, $('span.dob-p', undefined, String(plan.look)));
			DOM.append(row, $('.dob-r', undefined, $('span', undefined, localize('dispatchOnboarding.lookNote', "Not ticked. Pick the ones you mean."))));
			this.store.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => { c.lookOpen = !c.lookOpen; c.fire(); }));
			if (c.lookOpen) {
				for (const it of plan.look_items) {
					this.prefRow(list, it, c.lookOn.has(it.n), () => { c.lookOn.has(it.n) ? c.lookOn.delete(it.n) : c.lookOn.add(it.n); c.fire(); }, it.why);
				}
			}
		}
		DOM.append(wrap, $('p.dob-note', undefined, plan.left ? localize('dispatchOnboarding.prefsLeft', "{0} notes about projects and machines were left out: they are facts, not preferences.", plan.left) : localize('dispatchOnboarding.prefsFacts', "Notes about projects and machines are facts, not preferences: they stay where they are.")));
		if (!total) {
			DOM.append(list, $('.dob-empty', undefined, localize('dispatchOnboarding.noPrefs', "No preferences found in CLAUDE.md, AGENTS.md or the agents' memory. Agents will learn yours as you work.")));
		}
		this.frame(root, localize('dispatchOnboarding.prefsTitle', "Bring your preferences"), total
			? localize('dispatchOnboarding.prefsSub', "Found {0} things you told your agents to do or avoid. The {1} clear ones are ticked; every agent reads them at the start of a session.", total, plan.clear)
			: localize('dispatchOnboarding.prefsNone', "Nothing to bring over from your rules files or the agents' memory."), wrap, [
			this.skipButton(), this.backButton(),
			this.button(picks ? localize('dispatchOnboarding.importN', "Import {0} {1}", picks, plural(picks, 'preference', 'preferences')) : localize('dispatchOnboarding.continue', "Continue"), 'fill', () => c.next()),
		], stepNo);
	}

	private prefRow(list: HTMLElement, it: { polarity: string; text: string; source: string }, on: boolean, toggle: () => void, why?: string): void {
		const row = DOM.append(list, $('.dob-row.pref'));
		row.classList.toggle('with-why', !!why);
		row.appendChild(this.checkbox(on, it.text, toggle));
		DOM.append(row, $(`span.dob-gl${ThemeIcon.asCSSSelector(it.polarity === 'like' ? Codicon.thumbsup : Codicon.circleSlash)}`));
		const main = DOM.append(row, $('.dob-main'));
		DOM.append(main, $('.dob-n.reg.clip', { title: it.text }, it.text));
		if (why) {
			DOM.append(main, $('.dob-why', undefined, why));
		}
		DOM.append(row, $('.dob-r', undefined, $('span', undefined, it.source)));
		this.store.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, toggle));
	}

	// ---- 4 Rules

	private rulesScreen(root: HTMLElement): void {
		const c = this.c;
		const stepNo = c.stepList.indexOf('rules') + 1;
		const plan = c.rules;
		const body = $('.dob-scroll');
		this.keepScroll(body, 'rules');
		if (!plan) {
			DOM.append(body, $('.dob-skeleton'));
		} else {
			this.groupHead(body, localize('dispatchOnboarding.files', "Files"), plan.files.length);
			const w1 = this.well(body);
			for (const f of plan.files) {
				const row = DOM.append(w1, $('.dob-row'));
				DOM.append(row, $(`span.dob-gl.codicon.codicon-${f.id === 'dispatch' ? 'terminal' : f.id === 'dispatch.md' ? 'book' : 'file'}`));
				const main = DOM.append(row, $('.dob-main'));
				DOM.append(main, $('span.dob-n', undefined, f.id));
				DOM.append(main, $('span.dob-p', undefined, ` ${f.lines ? localize('dispatchOnboarding.lines', "{0} lines · {1}", f.lines, f.note) : f.note}`));
			}
			if (plan.agents.length) {
				this.groupHead(body, localize('dispatchOnboarding.agents', "Agents"), plan.agents.length);
				const w2 = this.well(body);
				for (const a of plan.agents) {
					const off = c.agentOff.has(a.id) || c.engineOff.has(a.id);
					const row = DOM.append(w2, $('.dob-row.agent'));
					row.appendChild(this.checkbox(!off, a.name, () => { c.agentOff.has(a.id) ? c.agentOff.delete(a.id) : c.agentOff.add(a.id); c.engineOff.delete(a.id); c.fire(); }));
					DOM.append(row, agentGlyph(a.id));
					const main = DOM.append(row, $('.dob-main'));
					const line = DOM.append(main, $('.dob-line'));
					DOM.append(line, $('span.dob-n', undefined, a.name));
					DOM.append(line, $('span.dob-p', undefined, a.path));
					DOM.append(main, $('.dob-why', undefined, `${localize('dispatchOnboarding.blockLines', "Adds one block ({0} lines)", a.block_lines)}${a.own_lines ? localize('dispatchOnboarding.afterYours', " after your {0} lines, which stay as they are", a.own_lines) : ''}. ${localize('dispatchOnboarding.hooks', "Hooks: {0}", a.hooks)}${a.hooks_note ? ` (${a.hooks_note})` : ''}.`));
				}
			} else {
				DOM.append(body, $('p.dob-note', undefined, localize('dispatchOnboarding.noAgents', "No agent is installed yet. Go Back to install one now, or install one later: Set up then shows in the title bar to connect it.")));
			}
			if (plan.left_alone.length) {
				DOM.append(body, $('p.dob-note', undefined, localize('dispatchOnboarding.leftAlone', "Left alone: {0}.", plan.left_alone.join(', '))));
			}
			const undo = DOM.append(body, $('p.dob-note.lock'));
			DOM.append(undo, icon('discard'));
			DOM.append(undo, $('span', undefined, localize('dispatchOnboarding.undoNote', "Everything is listed in Settings › Abilities › What Dispatch changed on this Mac, each line with Undo.")));
		}
		const n = c.connectAgents.length;
		const fresh = c.fresh;
		const one = plan && plan.agents.length === 1 ? plan.agents[0].name : undefined;
		this.frame(root, n === 1 && fresh && one ? localize('dispatchOnboarding.connectOne', "Connect Dispatch to {0}", one) : localize('dispatchOnboarding.connect', "Connect Dispatch to your agents"),
			localize('dispatchOnboarding.connectSubTools', "Dispatch adds one block to each agent's rules file, a few hooks, and its own tools for the task board (Settings › MCP servers turns them off). Everything else in those files stays as you wrote it."), body, [
			this.skipButton(), this.backButton(),
			this.button(localize('dispatchOnboarding.setUp', "Set up Dispatch"), 'fill', () => void c.run(), !plan || (c.vscodeOn && !c.vscodeScan)),
		], stepNo);
	}

	// ---- how much agents may do on their own

	private autonomyScreen(root: HTMLElement): void {
		const c = this.c;
		const stepNo = c.stepList.indexOf('autonomy') + 1;
		const body = $('.dob-scroll');
		this.keepScroll(body, 'autonomy');
		const info = c.status!.autonomy;
		const level = chosenAutonomy(c.autonomy, info);
		const well = this.well(body);
		this.gitIdentityGroup(body);
		for (const l of info?.levels ?? []) {
			const on = l.id === level;
			const pick = () => { c.autonomy = l.id; c.fire(); };
			const row = DOM.append(well, $('.dob-row.with-why'));
			row.appendChild(this.checkbox(on, l.title, pick));
			const main = DOM.append(row, $('.dob-main'));
			const line = DOM.append(main, $('.dob-line'));
			DOM.append(line, $('span.dob-n', undefined, l.title));
			if (l.id === DEFAULT_AUTONOMY) {
				DOM.append(line, $('span.dob-tag', undefined, localize('dispatchOnboarding.default', "Default")));
			}
			DOM.append(main, $('.dob-why', undefined, l.detail));
			this.store.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, e => { if ((e.target as HTMLElement).closest('.dob-cb')) { return; } pick(); }));
		}
		DOM.append(body, $('p.dob-note', undefined, localize('dispatchOnboarding.autonomyNote', "You can change this any time in Settings › Agents, and a single session can use its own setting.")));
		this.frame(root, localize('dispatchOnboarding.autonomyTitle', "Agent permissions"),
			localize('dispatchOnboarding.autonomySub', "Agents edit files and run commands for you. Choose when they check with you first."), body, [
			this.skipButton(), this.backButton(),
			this.button(localize('dispatchOnboarding.continue', "Continue"), 'fill', () => c.next()),
		], stepNo);
	}

	/** Whose name the commits carry, on a Mac where git has none: agents commit for the person, so it is asked here
	 *  once instead of the first agent making one up (kanban task-pog4t). The rows go into the well above it. */
	private gitIdentityGroup(body: HTMLElement): void {
		const c = this.c;
		const g = c.status?.git_identity;
		if (!g || g.known) {
			return;
		}
		const v = c.gitIdentityChoice();
		const slot = DOM.append(body, $('.dob-git-identity'));
		this.groupHead(slot, localize('dispatchOnboarding.gitIdentity', "Your name on commits"));
		const row = DOM.append(this.well(slot), $('.dob-row.with-why'));
		const main = DOM.append(row, $('.dob-main'));
		const line = DOM.append(main, $('.dob-line'));
		DOM.append(line, $('span.dob-n', undefined, v ? gitIdentityLine(v) : localize('dispatchOnboarding.gitIdentityNone', "Not set yet")));
		const from = !c.gitIdentity && g.suggest?.from && g.suggest.from !== 'git' ? localize('dispatchOnboarding.gitIdentityFrom', " Taken from {0}.", g.suggest.from) : '';
		DOM.append(main, $('.dob-why', undefined, v
			? localize('dispatchOnboarding.gitIdentityWhy', "Git puts it on every commit, yours and your agents'.{0}", from)
			: localize('dispatchOnboarding.gitIdentityAsk', "Git puts a name and email on every commit, yours and your agents'. Add yours now, or agents ask you before their first commit.")));
		row.appendChild(this.button(v ? localize('dispatchOnboarding.change', "Change") : localize('dispatchOnboarding.add', "Add"), 'xs', () => void c.changeGitIdentity()));
	}

	// ---- how Dispatch looks

	private appearanceScreen(root: HTMLElement): void {
		const c = this.c;
		const stepNo = c.stepList.indexOf('appearance') + 1;
		const body = $('.dob-scroll');
		const well = this.well(body);
		for (const t of THEME_CHOICES) {
			const on = c.theme === t.mode;
			const pick = () => void c.setTheme(t.mode);
			const row = DOM.append(well, $('.dob-row'));
			row.appendChild(this.checkbox(on, t.title, pick));
			DOM.append(row, $(`span.dob-swatch.${t.mode}`, { 'aria-hidden': 'true' }, $('i'), $('b')));
			const main = DOM.append(row, $('.dob-main'));
			DOM.append(main, $('span.dob-n', undefined, t.title));
			DOM.append(main, $('span.dob-p', undefined, ` ${t.detail}`));
			this.store.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, e => { if ((e.target as HTMLElement).closest('.dob-cb')) { return; } pick(); }));
		}
		DOM.append(body, $('p.dob-note', undefined, localize('dispatchOnboarding.appearanceNote', "The window changes as you choose. You can switch any time in Settings › Appearance.")));
		this.frame(root, localize('dispatchOnboarding.appearanceTitle', "Pick how Dispatch looks"),
			localize('dispatchOnboarding.appearanceSub', "Light, dark, or whatever your Mac is set to."), body, [
			this.skipButton(), this.backButton(),
			this.button(localize('dispatchOnboarding.continue', "Continue"), 'fill', () => c.next()),
		], stepNo);
	}

	// ---- notifications and keeping the Mac awake

	private notificationsScreen(root: HTMLElement): void {
		const c = this.c;
		const stepNo = c.stepList.indexOf('notifications') + 1;
		const body = $('.dob-scroll');
		this.groupHead(body, localize('dispatchOnboarding.notifications', "Notifications"));
		const w1 = this.well(body);
		const toggleNotify = () => { c.notifyOn = !c.notifyOn; c.fire(); };
		const row = DOM.append(w1, $('.dob-row.with-why'));
		row.appendChild(this.checkbox(c.notifyOn, NOTIFY_TEXT.title, toggleNotify));
		const main = DOM.append(row, $('.dob-main'));
		DOM.append(DOM.append(main, $('.dob-line')), $('span.dob-n', undefined, NOTIFY_TEXT.title));
		DOM.append(main, $('.dob-why', undefined, NOTIFY_TEXT.detail));
		this.store.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, e => { if ((e.target as HTMLElement).closest('.dob-cb, .dob-btn')) { return; } toggleNotify(); }));
		const actions = DOM.append(w1, $('.dob-row.plain'));
		actions.appendChild(this.button(localize('dispatchOnboarding.notifyTest', "Send a test notification"), 'xs', () => void c.notifyTest()));
		actions.appendChild(this.button(localize('dispatchOnboarding.notifySettings', "Open System Settings"), 'xs', () => void c.host.firstRun('notify-open').catch(() => undefined)));
		if (c.notifyMessage) {
			DOM.append(body, $('p.dob-note', { role: 'status' }, c.notifyMessage));
		}
		this.groupHead(body, localize('dispatchOnboarding.awake', "While agents work"));
		const w2 = this.well(body);
		const toggleAwake = () => { c.awakeOn = !c.awakeOn; c.fire(); };
		const arow = DOM.append(w2, $('.dob-row.with-why'));
		arow.appendChild(this.checkbox(c.awakeOn, AWAKE_TEXT.title, toggleAwake));
		const amain = DOM.append(arow, $('.dob-main'));
		DOM.append(DOM.append(amain, $('.dob-line')), $('span.dob-n', undefined, AWAKE_TEXT.title));
		DOM.append(amain, $('.dob-why', undefined, AWAKE_TEXT.detail));
		this.store.add(DOM.addDisposableListener(arow, DOM.EventType.CLICK, e => { if ((e.target as HTMLElement).closest('.dob-cb')) { return; } toggleAwake(); }));
		this.frame(root, localize('dispatchOnboarding.notifyTitle', "Stay in the loop"),
			localize('dispatchOnboarding.notifySub', "Agents can work while you do something else. Choose how Dispatch tells you, and whether the Mac keeps going."), body, [
			this.skipButton(), this.backButton(),
			this.button(localize('dispatchOnboarding.continue', "Continue"), 'fill', () => c.next()),
		], stepNo);
	}

	// ---- running

	private runScreen(root: HTMLElement): void {
		const c = this.c;
		const done = c.phase === 'finished';
		const body = $('.dob-scroll');
		const well = this.well(body);
		well.classList.add('prog');
		for (const s of c.steps) {
			const st = c.stepState.get(s.id)?.state ?? 'pending';
			const row = DOM.append(well, $(`.dob-pr.${st}`));
			const mark = DOM.append(row, $('span.mark'));
			if (st === 'done') {
				DOM.append(mark, icon('check'));
			} else if (st === 'running') {
				DOM.append(mark, $('span.dob-spin'));
			} else if (st === 'failed') {
				DOM.append(mark, icon('warning'));
			} else {
				DOM.append(mark, $('i.dot'));
			}
			const lab = DOM.append(row, $('span.lab', undefined, s.label));
			const detail = c.stepState.get(s.id)?.detail;
			DOM.append(row, $('span.dob-r', undefined, st === 'failed' ? localize('dispatchOnboarding.failed', "Could not finish") : detail && st === 'done' ? detail : ''));
			if (st === 'failed' && detail) {
				// which part and why, under the step (kanban task-4xxj): it was only in a tooltip
				DOM.append(lab, $('span.dob-why', undefined, detail));
				row.title = detail;
			}
		}
		if (done) {
			DOM.append(body, $('p.dob-note', undefined, c.failed.length
				? localize('dispatchOnboarding.doneFailed', "Some steps could not finish. Retry them, or skip setup and continue later.")
				: localize('dispatchOnboarding.doneAllUndo', "Done. Nothing else to set up. Settings › Abilities › What Dispatch changed on this Mac lists each change, with Undo.")));
		} else {
			DOM.append(body, $('p.dob-note', undefined, localize('dispatchOnboarding.filling', "The sidebar fills in as each step finishes.")));
		}
		// a failed step is not "ready" (kanban task-4xxj): the title and the line under it say the same thing
		const failedSteps = c.steps.filter(x => c.failed.includes(x.id)).length;
		this.frame(root, done && c.failed.length ? localize('dispatchOnboarding.attentionTitle', "Setup needs attention") : done ? localize('dispatchOnboarding.doneTitle', "Dispatch is set up") : localize('dispatchOnboarding.settingUp', "Setting up"),
			done && c.failed.length ? (failedSteps === 1
				? localize('dispatchOnboarding.attentionSubOne', "{0} of {1} steps finished. The one that did not says why.", c.steps.length - failedSteps, c.steps.length)
				: localize('dispatchOnboarding.attentionSubMany', "{0} of {1} steps finished. The ones that did not say why.", c.steps.length - failedSteps, c.steps.length))
				: done ? localize('dispatchOnboarding.doneSub', "Your setup is ready. Start a conversation to begin.") : localize('dispatchOnboarding.settingSub', "Your projects, preferences and agents are being connected."), body, [
			...(done && c.failed.length ? [this.skipButton()] : []),
			this.button(done && c.failed.length ? 'Retry setup' : done ? localize('dispatchOnboarding.start', "Start") : localize('dispatchOnboarding.settingBtn', "Setting up..."), 'fill', () => { if (c.failed.length) { void c.run(); } else { c.host.leave(true); } }, !done),
		]);
	}
}
