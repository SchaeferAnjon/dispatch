/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchStatusBar.css';

import * as DOM from '../../../../base/browser/dom.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableSignalFromEvent } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { SessionStatus } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { AccountsModel, engineIcon, engineName, IEngineStatus, liveWindows, longWindow, pct, showDispatchAccountsPanel } from '../../dispatchAccounts/browser/dispatchAccounts.contribution.js';
import { dispatchChecklistEntry, renderDispatchRing } from '../../dispatchTours/browser/dispatchChecklist.js';
import { DISPATCH_SETTINGS_OPEN, settingsOpen } from '../../dispatchSettings/browser/dispatchSettingsState.js';
import { agentsBusy, allowanceWords, duration, gaugeCells, IDispatchBuild, IDispatchBuildLists, IDispatchBuildQueue, isNewUser, NARROW_WIDTH, parseBuildQueue, queueBlocks } from './dispatchStatusBarModel.js';
import { setDispatchStatusBarHeight } from './dispatchStatusBarSpace.js';
import { AwakeMode, awakeMode, awakeWords, awakeWorking, IAwakeState } from './dispatchAwakeWords.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';
import { IUpdateService, State as UpdateState, StateType as UpdateStateType } from '../../../../platform/update/common/update.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { busyWords, IDispatchBusy, parseBusy } from './dispatchStatusBarModel.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
// Dispatch IDE: a Turbo run's bolt and the stripes of what it still plans to use (420-turbo.patch)
import { dispatchActiveInterval } from '../../../../workbench/contrib/dispatchMotion/browser/dispatchIdle.js';
import { dispatchTurboHooks, onDispatchTurboChange, turboGoing } from '../../dispatchTurbo/browser/dispatchTurboHooks.js';

// Dispatch IDE: the Agents window's bottom bar, "Status in blocks" (kanban design/bars, direction B; task-in8g).
// Up top is where you are and who you are; down here is what changes by itself. Usually a few quiet blocks: Settings
// (moved here from the side bar's foot, the user's call 10-10; the terminal's switch went up beside the session
// title, dispatchTitleBar/browser/dispatchEditorEntry.ts) at the left (Run went away 10-31: the person could not tell
// what it was for, blurt DIS-4; F5 still runs the project); at the right the build queue (one block per build, the running one
// fills up), a cup while the Mac is kept awake, and one ten-cell gauge per engine for its allowance. Words show only
// when something needs you ("83% used · 01:00", "Build failed", "+2"), and in a new person's first week every block
// says what it is in a word. Each block opens a panel. Everything comes from the dispatch CLI through dispatch-bridge:
// `dispatch.accounts` (the accounts model shared with the Accounts panel), `dispatch.builds`, `dispatch.awake`.

const BAR_HEIGHT = 28;
const BUILDS_EVERY_MS = 20_000;
const AWAKE_EVERY_MS = 30_000;
const BUSY_EVERY_MS = 30_000;
const LATER_KEY = 'dispatch.statusBar.updateLater';
const TICK_MS = 5_000;
const ASK_MS = 60_000;
const DONE_SHOWN_MS = 10_000;
const FIRST_SEEN_KEY = 'dispatch.statusBar.firstSeen';
const SEEN_FAILURES_KEY = 'dispatch.statusBar.seenFailures';
const SVG_NS = 'http://www.w3.org/2000/svg';

type IAwake = IAwakeState;

type PanelKind = 'builds' | 'awake' | 'busy' | 'update';

function svg(width: number, height: number, cls: string): SVGSVGElement {
	const s = mainWindow.document.createElementNS(SVG_NS, 'svg');
	s.setAttribute('width', String(width));
	s.setAttribute('height', String(height));
	s.setAttribute('viewBox', `0 0 ${width} ${height}`);
	s.setAttribute('aria-hidden', 'true');
	s.setAttribute('class', cls);
	return s;
}

function svgChild<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
	const e = mainWindow.document.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) {
		e.setAttribute(k, String(v));
	}
	parent.appendChild(e);
	return e;
}

let hatches = 0;
/**
 * The ten-cell gauge (five in a narrow window): one cell is a tenth of the allowance, as many lit as are used
 * (it fills up like the meters in Settings and the account panel's numbers).
 * `plan`: the % more a Turbo run still plans to use, striped in the cells after the used ones.
 */
function gauge(used: number, cells: number, low: boolean, plan = 0): SVGSVGElement {
	const cw = 5, gap = 2, h = 12, w = cells * (cw + gap) - gap;
	const s = svg(w, h, `dispatch-status-gauge${low ? ' low' : ''}${plan > 0 ? ' turbo' : ''}`);
	const keep = gaugeCells(used, cells);
	const id = `dispatch-turbo-hatch-${++hatches}`;
	if (plan > 0) {
		const pattern = svgChild(svgChild(s, 'defs', {}), 'pattern', { id, width: 2.4, height: 2.4, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
		svgChild(pattern, 'rect', { class: 'hatch', x: 0, y: 0, width: 1.1, height: 2.4 });
	}
	gaugeCells(Math.min(100, used + plan), cells).forEach((f, i) => {
		const x = i * (cw + gap);
		svgChild(s, 'rect', { class: 'cell', x: x + 0.5, y: 0.5, width: cw - 1, height: h - 1, rx: 1.6 });
		const k = Math.min(f, keep[i]);
		if (k > 0) {
			svgChild(s, 'rect', { class: 'fill', x, y: (h - h * k).toFixed(2), width: cw, height: (h * k).toFixed(2), rx: 1.6 });
		}
		if (f > k) {
			svgChild(s, 'rect', { class: 'plan', x, y: (h - h * f).toFixed(2), width: cw, height: (h * (f - k)).toFixed(2), rx: 1.6, fill: `url(#${id})` });
		}
	});
	return s;
}

/** "Busy": a gauge with its needle far over (the design's glyph). */
function busyGlyph(size: number): SVGSVGElement {
	const s = svg(size, size, 'dispatch-status-glyph');
	s.setAttribute('viewBox', '0 0 16 16');
	svgChild(s, 'path', { d: 'M2.6 11.4a5.4 5.4 0 1 1 10.8 0' });
	svgChild(s, 'path', { d: 'M8 11.4l2.7-3.2' });
	svgChild(s, 'circle', { cx: 8, cy: 11.4, r: 0.9, class: 'f' });
	return s;
}

/** "Restart to update": an arrow up out of the block. */
function upGlyph(size: number): SVGSVGElement {
	const s = svg(size, size, 'dispatch-status-glyph');
	s.setAttribute('viewBox', '0 0 16 16');
	svgChild(s, 'path', { d: 'M8 11.5V4.8M5.4 7.2L8 4.6l2.6 2.6' });
	return s;
}

/** The cup: steam rises while agents work. */
function cup(size: number): SVGSVGElement {
	const s = svg(size, size, 'dispatch-status-cup');
	s.setAttribute('viewBox', '0 0 16 16');
	svgChild(s, 'path', { d: 'M3 6.6h7.4v3a3.1 3.1 0 0 1-3.1 3.1H6.1A3.1 3.1 0 0 1 3 9.6z' });
	svgChild(s, 'path', { d: 'M10.4 7.4h.8a1.4 1.4 0 0 1 0 2.8h-.8' });
	svgChild(s, 'path', { class: 'steam', d: 'M5.5 2.4c-.5.6.5 1.1 0 1.8' });
	svgChild(s, 'path', { class: 'steam s2', d: 'M8 2.4c-.5.6.5 1.1 0 1.8' });
	return s;
}

function hostName(host: string): string {
	return host === 'mini' ? localize('dispatchStatusBar.mini', "mini") : localize('dispatchStatusBar.thisMac', "this Mac");
}

/** Where a failed build of yours stopped, in words (the CLI's `step`, task-7ve7v). */
function stepWords(b: IDispatchBuild): string {
	switch (b.step ?? (b.stage === 'checks' ? 'checks' : 'start')) {
		case 'checkout': return localize('dispatchStatusBar.stepCheckout', "Stopped while getting the code");
		case 'dependencies': return localize('dispatchStatusBar.stepDeps', "Stopped while installing its dependencies");
		case 'build': return localize('dispatchStatusBar.stepBuild', "Stopped while compiling and packaging");
		case 'checks': return localize('dispatchStatusBar.stepChecks', "Built, then failed its checks");
		case 'stopped': return localize('dispatchStatusBar.stepStopped', "The build stopped without saying why");
		default: return localize('dispatchStatusBar.stepStart', "Didn't start building");
	}
}

/** "~/dispatch-builds/…/build.log on the mini": a log's place, home folder shortened. */
function logPlace(b: IDispatchBuild): string {
	const path = (b.log ?? '').replace(/^\/Users\/[^/]+\//, '~/');
	return b.host === 'mini'
		? localize('dispatchStatusBar.logOnMini', "{0} on the Mac mini", path)
		: localize('dispatchStatusBar.logHere', "{0} on this Mac", path);
}

class DispatchStatusBar extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.dispatchStatusBar';

	private readonly bar: HTMLElement;
	private readonly settings: HTMLElement;
	private readonly checklist: HTMLElement;
	private readonly whatsNew: HTMLElement;
	private readonly checklistListener = this._register(new MutableDisposable());
	private readonly failed: HTMLElement;
	private readonly builds: HTMLElement;
	private readonly awake: HTMLElement;
	private readonly busy: HTMLElement;
	private readonly update: HTMLElement;
	private busyState: IDispatchBusy | undefined;
	private updateState: UpdateState;
	private sleepAsked = 0;
	private busyPreview = false;
	private readonly allowance: HTMLElement;
	private readonly panel = this._register(new MutableDisposable<DisposableStore>());
	/** One block per signed-in engine, kept across readings (only its insides are drawn again). */
	private readonly allowanceItems = new Map<string, HTMLElement>();
	private panelKind: PanelKind | 'accounts' | undefined;

	private readonly accounts: AccountsModel;
	private queue: IDispatchBuildQueue | undefined;
	private awakeState: IAwake | undefined;
	/** The Keep awake panel is open (the cup stays while it is, even once the switch let the Mac sleep). */
	private awakeOpen = false;
	/** Draws the open Keep awake panel's words and switches again. */
	private awakePanelDraw: (() => void) | undefined;
	/** The mode before the panel's switch let the Mac sleep: turning it back on goes back to it. */
	private awakeLastOn: AwakeMode = 'system';
	/** The mode a switch just asked for, until the setting has it: the panel's words follow the click, not the write. */
	private awakePending: AwakeMode | undefined;
	private working = 0;
	private narrow = false;
	private readonly doneSeen = new Map<string, number>();
	private seenFailures: Set<string>;
	private readonly firstSeen: number;
	private asking = false;
	private buildsDrawn = '';
	/** The Builds panel's "Agents' test builds" group: folded unless the person opened it. */
	private agentsOpen = false;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
		@IHoverService private readonly hoverService: IHoverService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IStorageService private readonly storageService: IStorageService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@ISessionsManagementService sessionsManagement: ISessionsManagementService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IUpdateService private readonly updateService: IUpdateService,
	) {
		super();
		this.firstSeen = this.readFirstSeen();
		this.seenFailures = new Set(JSON.parse(this.storageService.get(SEEN_FAILURES_KEY, StorageScope.APPLICATION, '[]')) as string[]);

		this.bar = DOM.$('.dispatch-status-bar', { role: 'toolbar', 'aria-label': localize('dispatchStatusBar.label', "Status") });
		this.bar.dataset.part = 'bottom-bar';
		const left = DOM.append(this.bar, DOM.$('.dispatch-status-group.left'));
		DOM.append(this.bar, DOM.$('.dispatch-status-grow'));
		const right = DOM.append(this.bar, DOM.$('.dispatch-status-group.right'));
		this.settings = this.item(left, 'settings', () => localize('dispatchStatusBar.settingsTip', "Settings (⌘,)"), () => void this.commandService.executeCommand(DISPATCH_SETTINGS_OPEN));
		// one-time things that used to sit in the title bar: Getting started (a new person's checklist) and What's new
		this.checklist = this.item(left, 'getting-started', () => this.checklistTip(), () => dispatchChecklistEntry()?.click(this.checklist));
		this.checklist.classList.add('dispatch-checklist-entry');
		// only when it needs you: the Mac is too busy; a new version is ready
		this.busy = this.item(right, 'mac-busy', () => this.busyTip(), () => this.togglePanel('busy', this.busy));
		this.busy.classList.add('hot');
		this.whatsNew = this.item(right, 'whats-new', () => localize('dispatchStatusBar.whatsNewTip', "See what is new in this update"), () => void this.commandService.executeCommand('dispatch.whatsNew.show'));
		this.whatsNew.classList.add('dispatch-whats-new-entry', 'hot');
		this.failed = this.item(right, 'build-failed', () => this.failedTip(), () => this.togglePanel('builds', this.failed));
		this.builds = this.item(right, 'builds', () => this.buildsTip(), () => this.togglePanel('builds', this.builds));
		this.awake = this.item(right, 'keep-awake', () => this.awakeTip(), () => this.togglePanel('awake', this.awake));
		this.allowance = DOM.append(right, DOM.$('.dispatch-status-allowances'));
		this.update = this.item(right, 'update', () => this.updateTip(), () => this.togglePanel('update', this.update));
		this.update.classList.add('hot');
		this.updateState = updateService.state;
		this._register(updateService.onStateChange(state => {
			this.updateState = state;
			this.drawUpdate();
		}));
		// Developer: what the bar shows for a state this Mac is not in (a ready update, a busy Mac), to check how it looks
		previewRareBlocks = async (what) => {
			if (what === 'real') {
				this.updateState = this.updateService.state;
				this.busyPreview = false;
				this.drawUpdate();
				void this.askBusy();
				return;
			}
			if (what === 'update' || what === 'both') {
				this.updateState = UpdateState.Ready({ version: 'preview', productVersion: localize('dispatchStatusBar.previewVersion', "the next version") }, false, false);
				this.storageService.remove(LATER_KEY, StorageScope.APPLICATION);
				this.drawUpdate();
			}
			if (what === 'busy' || what === 'both') {
				this.busyPreview = true;
				this.busyState = { busy: true, why: 'memory', agents: Math.max(1, this.working), builds: 1 };
				this.drawBusy();
			}
		};
		this._register(toDisposable(() => { previewRareBlocks = undefined; }));

		const container = this.layoutService.mainContainer;
		container.appendChild(this.bar);
		container.classList.add('dispatch-has-status-bar');
		this._register(toDisposable(() => {
			this.bar.remove();
			container.classList.remove('dispatch-has-status-bar');
			setDispatchStatusBarHeight(0);
			this.layoutService.layout();
		}));
		setDispatchStatusBarHeight(BAR_HEIGHT);
		this.layoutService.layout();
		this._register(this.layoutService.onDidLayoutMainContainer(dim => this.setNarrow(dim.width < NARROW_WIDTH)));
		this.setNarrow(container.clientWidth > 0 && container.clientWidth < NARROW_WIDTH);

		// Settings is pressed while its page is the one in the middle
		this._register(autorun(reader => {
			const open = settingsOpen.read(reader);
			this.settings.classList.toggle('open', open);
			this.settings.setAttribute('aria-pressed', String(open));
		}));
		const onceKeys = new Set(['dispatchChecklistVisible', 'dispatchSetupPending', 'dispatchSetupShown', 'dispatchWhatsNewVisible']);
		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(onceKeys)) {
				this.drawOnce();
			}
		}));

		// how many agents work now: the cup steams
		const changed = observableSignalFromEvent('dispatchStatusBarSessions', sessionsManagement.onDidChangeSessions);
		this._register(autorun(reader => {
			changed.read(reader);
			let n = 0;
			for (const s of sessionsManagement.getSessions()) {
				if (s.status.read(reader) === SessionStatus.InProgress) {
					n++;
				}
			}
			if (n !== this.working) {
				this.working = n;
				this.drawAwake();
				this.askAwakeSoon(); // an agent started or finished: the background service holds or lets go on its next pass
			}
		}));

		this.accounts = AccountsModel.get(commandService);
		this._register(this.accounts.onDidChange(() => this.drawAllowance()));
		this._register(onDispatchTurboChange(what => what === 'live' && this.drawAllowance()));
		this.accounts.start();

		// the bar's questions are for a window somebody looks at: a hidden or forgotten one waits (dispatchIdle.ts)
		this._register(dispatchActiveInterval(mainWindow, () => void this.askBuilds(), BUILDS_EVERY_MS));
		this._register(dispatchActiveInterval(mainWindow, () => void this.askAwake(), AWAKE_EVERY_MS));
		this._register(dispatchActiveInterval(mainWindow, () => void this.askBusy(), BUSY_EVERY_MS));
		const tick = mainWindow.setInterval(() => this.drawBuilds(), TICK_MS);
		this._register(toDisposable(() => mainWindow.clearInterval(tick)));
		this._register(DOM.addDisposableListener(mainWindow, DOM.EventType.FOCUS, () => void this.askBuilds()));
		// the mode changed (Settings › Keep awake or the cup's panel): the cup and an open panel follow at once (off hides
		// the cup once its panel is closed, screen on changes its words)
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('dispatch.keepAwake')) {
				this.awakePanelDraw?.();
				this.askAwakeSoon();
			}
		}));
		this._register(toDisposable(() => this.awakeSoon.forEach(t => mainWindow.clearTimeout(t))));
		this.drawAll();
		void this.askBuilds();
		void this.askAwake();
		void this.askBusy();
	}

	/** When this person first saw the bar; 0 for someone who used Dispatch before it had one (no words for them). */
	private readFirstSeen(): number {
		const stored = this.storageService.getNumber(FIRST_SEEN_KEY, StorageScope.APPLICATION, -1);
		if (stored >= 0) {
			return stored;
		}
		const before = this.storageService.get('dispatch.whatsNew.seen', StorageScope.APPLICATION) !== undefined;
		const value = before ? 0 : Date.now();
		this.storageService.store(FIRST_SEEN_KEY, value, StorageScope.APPLICATION, StorageTarget.MACHINE);
		return value;
	}

	private get newUser(): boolean {
		return isNewUser(this.firstSeen, Date.now());
	}

	// ---- the blocks ----------------------------------------------------------------------------

	private item(parent: HTMLElement, part: string, tip: () => string, click: () => void): HTMLElement {
		const el = DOM.append(parent, DOM.$('a.dispatch-status-item', { role: 'button', tabindex: '0' }));
		el.dataset.part = part;
		el.hidden = true;
		this._register(this.hoverService.setupDelayedHover(el, () => ({
			content: tip(),
			position: { hoverPosition: HoverPosition.ABOVE },
			appearance: { showPointer: true },
		})));
		this._register(DOM.addDisposableListener(el, DOM.EventType.CLICK, e => {
			DOM.EventHelper.stop(e, true);
			click();
		}));
		this._register(DOM.addDisposableListener(el, DOM.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter' || e.key === ' ') {
				DOM.EventHelper.stop(e, true);
				click();
			}
		}));
		return el;
	}

	/** A word after a block, in a new person's first week (not in a narrow window). */
	private word(el: HTMLElement, text: string): void {
		if (this.newUser && !this.narrow) {
			DOM.append(el, DOM.$('span.dispatch-status-word', undefined, text));
		}
	}

	private setNarrow(narrow: boolean): void {
		if (narrow !== this.narrow) {
			this.narrow = narrow;
			this.bar.classList.toggle('narrow', narrow);
			this.drawAll();
		}
	}

	private drawAll(): void {
		this.drawSettings();
		this.drawOnce();
		this.drawBuilds();
		this.drawAwake();
		this.drawAllowance();
		this.drawBusy();
		this.drawUpdate();
	}

	private drawSettings(): void {
		const el = this.settings;
		DOM.clearNode(el);
		DOM.append(el, DOM.$(`span.dispatch-status-engine${ThemeIcon.asCSSSelector(Codicon.settingsGear)}`));
		this.word(el, localize('dispatchStatusBar.settings', "Settings"));
		el.setAttribute('aria-label', localize('dispatchStatusBar.settingsLabel', "Settings (⌘,)"));
		el.hidden = false;
	}

	/** Getting started while a new person's checklist is open (not while setup is due); What's new after an update. */
	private drawOnce(): void {
		const entry = dispatchChecklistEntry();
		// not while setup is due, nor over the setup page itself (dispatchSetupPending is off while it is on screen)
		const showList = !!entry && !!this.contextKeyService.getContextKeyValue<boolean>('dispatchChecklistVisible') && !this.contextKeyService.getContextKeyValue<boolean>('dispatchSetupPending')
			&& !this.contextKeyService.getContextKeyValue<boolean>('dispatchSetupShown');
		const c = this.checklist;
		c.hidden = !showList;
		if (showList && entry) {
			const draw = () => {
				const p = entry.checklist.progress;
				DOM.clearNode(c);
				c.append(renderDispatchRing(p));
				DOM.append(c, DOM.$('span.dispatch-status-word', undefined, this.narrow
					? localize('dispatchStatusBar.checklistShort', "{0}/{1}", p.done, p.total)
					: localize('dispatchStatusBar.checklist', "Getting started · {0} of {1}", p.done, p.total)));
				c.setAttribute('aria-label', this.checklistTip());
			};
			draw();
			this.checklistListener.value = entry.checklist.onDidChange(draw);
		} else {
			this.checklistListener.clear();
		}
		const w = this.whatsNew;
		const showNew = !!this.contextKeyService.getContextKeyValue<boolean>('dispatchWhatsNewVisible');
		w.hidden = !showNew;
		if (showNew && !w.childElementCount) {
			DOM.append(w, DOM.$(`span.dispatch-status-engine${ThemeIcon.asCSSSelector(Codicon.gift)}`));
			DOM.append(w, DOM.$('span.dispatch-status-text', undefined, localize('dispatchStatusBar.whatsNew', "What's new")));
			w.setAttribute('aria-label', localize('dispatchStatusBar.whatsNewTip', "See what is new in this update"));
		}
	}

	private checklistTip(): string {
		const p = dispatchChecklistEntry()?.checklist.progress;
		return p
			? localize('dispatchStatusBar.checklistTip', "Getting started: {0} of {1} done. Click for the next step.", p.done, p.total)
			: localize('dispatchStatusBar.checklistTipNone', "Getting started");
	}

	// ---- builds ---------------------------------------------------------------------------------

	private async askBuilds(): Promise<void> {
		if (this.asking) {
			return;
		}
		this.asking = true;
		try {
			const r = await raceTimeout(this.commandService.executeCommand<unknown>('dispatch.builds', 'queue'), ASK_MS);
			const q = parseBuildQueue(r);
			if (q || r !== undefined) {
				this.queue = q;
			}
		} catch {
			this.queue = undefined;
		} finally {
			this.asking = false;
			this.drawBuilds();
		}
	}

	/** Builds that finished: shown with a tick for a few seconds after the bar first saw them, then gone. */
	private freshDone(q: IDispatchBuildQueue): IDispatchBuildQueue {
		const now = Date.now();
		for (const d of q.done) {
			if (!this.doneSeen.has(d.name)) {
				this.doneSeen.set(d.name, now);
			}
		}
		return { ...q, done: q.done.filter(d => now - (this.doneSeen.get(d.name) ?? now) < DONE_SHOWN_MS) };
	}

	private unseenFailures(): IDispatchBuild[] {
		return (this.queue?.failed ?? []).filter(f => !this.seenFailures.has(f.name));
	}

	private drawBuilds(): void {
		const q = this.queue ? this.freshDone(this.queue) : undefined;
		// a failure nobody looked at yet: the one block with words
		const unseen = this.unseenFailures();
		const f = this.failed;
		f.hidden = !unseen.length;
		f.classList.add('hot');
		const failedShape = `${unseen.length}|${this.narrow}`;
		if (unseen.length && failedShape !== f.dataset.shape) {
			f.dataset.shape = failedShape;
			DOM.clearNode(f);
			DOM.append(f, DOM.$('span.dispatch-status-qb.fail'));
			if (!this.narrow) {
				DOM.append(f, DOM.$('span.dispatch-status-text', undefined, unseen.length > 1
					? localize('dispatchStatusBar.buildsFailed', "{0} builds failed", unseen.length)
					: localize('dispatchStatusBar.buildFailed', "Build failed")));
			}
		}

		const el = this.builds;
		const blocks = queueBlocks(q, this.narrow ? 3 : 6, Date.now() / 1000);
		// the agents' test builds: one quiet block while any runs or waits, nothing once they end (task-7ve7v)
		const busy = agentsBusy(this.queue) > 0;
		el.hidden = !blocks.head && !blocks.waiting && !busy;
		if (el.hidden) {
			this.buildsDrawn = '';
			return;
		}
		el.setAttribute('aria-label', this.buildsTip());
		// the same blocks as last time: only the running one grows (drawing them again would restart their animations)
		const shape = [blocks.head?.state, blocks.head?.build.name, blocks.waiting, blocks.more, busy, this.narrow, this.newUser].join('|');
		if (shape === this.buildsDrawn) {
			const fill = el.querySelector<HTMLElement>('.dispatch-status-qb.run > i');
			if (fill && blocks.head) {
				fill.style.height = `${Math.round(blocks.head.progress * 100)}%`;
			}
			return;
		}
		this.buildsDrawn = shape;
		DOM.clearNode(el);
		const row = DOM.append(el, DOM.$('span.dispatch-status-queue'));
		if (blocks.head) {
			const h = blocks.head;
			if (h.state === 'done') {
				const b = DOM.append(row, DOM.$('span.dispatch-status-qb.done'));
				DOM.append(b, DOM.$(`span${ThemeIcon.asCSSSelector(Codicon.check)}`));
			} else {
				const b = DOM.append(row, DOM.$('span.dispatch-status-qb.run'));
				b.classList.toggle('checks', h.state === 'checks');
				const fill = DOM.append(b, DOM.$('i'));
				fill.style.height = `${Math.round(h.progress * 100)}%`;
			}
		}
		for (let i = 0; i < blocks.waiting; i++) {
			DOM.append(row, DOM.$('span.dispatch-status-qb'));
		}
		if (blocks.more) {
			DOM.append(row, DOM.$('span.dispatch-status-count', undefined, `+${blocks.more}`));
		}
		if (busy) {
			DOM.append(row, DOM.$('span.dispatch-status-qb.agents'));
		}
		this.word(el, localize('dispatchStatusBar.builds', "Builds"));
	}

	private buildsTip(): string {
		const q = this.queue;
		if (!q) {
			return localize('dispatchStatusBar.buildsNone', "Builds");
		}
		const run = q.building.find(b => b.stage !== 'checks');
		const checks = q.building.find(b => b.stage === 'checks');
		const waiting = q.waiting.length + Math.max(0, q.building.length - 1);
		const parts: string[] = [];
		if (run) {
			parts.push(localize('dispatchStatusBar.buildingTip', "Building on {0} · {1} · {2} waiting", hostName(run.host), duration(run.seconds), waiting));
		} else if (checks) {
			parts.push(localize('dispatchStatusBar.checksTip', "Checking a build on {0} · {1} waiting", hostName(checks.host), waiting));
		} else if (q.done.length) {
			parts.push(localize('dispatchStatusBar.builtTip', "Built just now: {0}", q.done[0].label));
		} else if (waiting) {
			parts.push(localize('dispatchStatusBar.waitingTip', "{0} builds waiting", waiting));
		}
		const busy = agentsBusy(q);
		if (busy) {
			parts.push(busy === 1
				? localize('dispatchStatusBar.agentsBusyOne', "An agent is test-building its changes")
				: localize('dispatchStatusBar.agentsBusyN', "Agents are test-building their changes ({0})", busy));
		}
		return parts.join('\n') || localize('dispatchStatusBar.buildsIdle', "Nothing is building");
	}

	private failedTip(): string {
		const u = this.unseenFailures();
		if (!u.length) {
			return '';
		}
		const f = u[0];
		const what = f.stage === 'checks'
			? localize('dispatchStatusBar.failedChecksTip', "Your build failed its checks: {0}", f.label)
			: localize('dispatchStatusBar.failedBuildTip', "Your build did not build: {0}", f.label);
		return `${what}\n${stepWords(f)}\n${localize('dispatchStatusBar.failedClick', "Click for the log and to try again.")}`;
	}

	// ---- keep awake -------------------------------------------------------------------------------

	private awakeSoon: number[] = [];

	/** Ask again shortly, and once more after the background service's next pass (every 20 s, kanban awake.py). */
	private askAwakeSoon(): void {
		this.awakeSoon.forEach(t => mainWindow.clearTimeout(t));
		this.awakeSoon = [1500, 23_000].map(ms => mainWindow.setTimeout(() => void this.askAwake(), ms));
	}

	private async askAwake(): Promise<void> {
		try {
			const r = await raceTimeout(this.commandService.executeCommand<IAwake>('dispatch.awake'), ASK_MS);
			this.awakeState = r && typeof r === 'object' && 'holding' in r ? r : undefined;
		} catch {
			this.awakeState = undefined; // a build without Keep awake
		}
		this.drawAwake();
	}

	/** `dispatch.keepAwake` now: it leads what the background service last held (that follows within seconds). */
	private awakeMode(): AwakeMode {
		return this.awakePending ?? awakeMode(this.configurationService.getValue('dispatch.keepAwake'));
	}

	private drawAwake(): void {
		this.awakePanelDraw?.();
		const el = this.awake;
		// while its panel is open the cup stays, also after the panel's switch let the Mac sleep: the panel is anchored to it
		const holding = (!!this.awakeState?.holding && this.awakeMode() !== 'off') || this.awakeOpen;
		el.hidden = !holding;
		if (!holding) {
			return;
		}
		el.classList.toggle('working', awakeWorking(this.awakeState, this.working) > 0);
		el.setAttribute('aria-label', this.awakeTip());
		const shape = `${this.newUser}|${this.narrow}`;
		if (shape !== el.dataset.shape) {
			el.dataset.shape = shape;
			DOM.clearNode(el);
			el.append(cup(14));
			this.word(el, localize('dispatchStatusBar.awake', "Awake"));
		}
	}

	private awakeTip(): string {
		const w = awakeWords(this.awakeState, this.working, this.awakeMode());
		return w.count ? `${w.head}\n${w.count}` : w.head;
	}

	// ---- the Mac is busy ------------------------------------------------------------------------

	private async askBusy(): Promise<void> {
		try {
			const r = await raceTimeout(this.commandService.executeCommand<unknown>('dispatch.busy'), ASK_MS);
			if (r !== undefined && !this.busyPreview) {
				this.busyState = parseBusy(r);
			}
		} catch {
			this.busyState = undefined; // a bridge without it
		}
		this.drawBusy();
	}

	private drawBusy(): void {
		const el = this.busy;
		const b = this.busyState;
		el.hidden = !b?.busy;
		if (!b?.busy) {
			if (this.panelKind === 'busy') {
				this.panel.clear();
			}
			return;
		}
		const shape = `${this.narrow}`;
		if (shape !== el.dataset.shape) {
			el.dataset.shape = shape;
			DOM.clearNode(el);
			el.append(busyGlyph(14));
			if (!this.narrow) {
				DOM.append(el, DOM.$('span.dispatch-status-text', undefined, localize('dispatchStatusBar.busy', "Busy")));
			}
		}
		el.setAttribute('aria-label', this.busyTip());
	}

	private busyText() {
		return busyWords(this.busyState, {
			memory: localize('dispatchStatusBar.busyMemory', "most of its memory"),
			processors: localize('dispatchStatusBar.busyCpu', "its processors"),
			agents: n => n === 1 ? localize('dispatchStatusBar.oneAgent', "1 agent") : localize('dispatchStatusBar.nAgents', "{0} agents", n),
			builds: n => n === 1 ? localize('dispatchStatusBar.oneBuild', "a build") : localize('dispatchStatusBar.nBuilds', "{0} builds", n),
			and: (a, b) => localize('dispatchStatusBar.and', "{0} and {1}", a, b),
			using: (who, what) => localize('dispatchStatusBar.busyUsing', "{0} are using {1}, so things feel slow.", who, what),
			usingOne: (who, what) => localize('dispatchStatusBar.busyUsingOne', "{0} is using {1}, so things feel slow.", who, what),
			others: what => localize('dispatchStatusBar.busyOthers', "Apps on this Mac are using {0}, so things feel slow.", what),
		});
	}

	private busyTip(): string {
		return `${localize('dispatchStatusBar.busyHead', "Your Mac is busy")}\n${this.busyText()}`;
	}

	private busyPanel(): HTMLElement {
		const panel = DOM.$('.dispatch-status-panel.busy', { 'aria-label': localize('dispatchStatusBar.busyPanel', "Your Mac is busy") });
		const row = DOM.append(panel, DOM.$('.dispatch-status-prow.top'));
		const lead = DOM.append(row, DOM.$('span.dispatch-status-plead'));
		lead.append(busyGlyph(20));
		const t = DOM.append(row, DOM.$('.dispatch-status-prow-text'));
		DOM.append(t, DOM.$('span.dispatch-status-prow-title', undefined, localize('dispatchStatusBar.busyHead', "Your Mac is busy")));
		const asked = Date.now() - this.sleepAsked < 5 * 60_000;
		DOM.append(t, DOM.$('span.dispatch-status-prow-sub', undefined, asked
			? `${this.busyText()} ${localize('dispatchStatusBar.sleepAsked', "The agents with nothing to do are going to sleep; each wakes up when you open it.")}`
			: `${this.busyText()} ${localize('dispatchStatusBar.sleepWhy', "Agents with nothing to do can sleep and wake up when you open them.")}`));
		const foot = DOM.append(panel, DOM.$('.dispatch-status-pfoot.buttons'));
		const what = DOM.append(foot, DOM.$('a.dispatch-status-link', { role: 'button', tabindex: '0' }, localize('dispatchStatusBar.whatUses', "What uses it")));
		what.style.marginRight = 'auto';
		what.onclick = e => {
			DOM.EventHelper.stop(e, true);
			this.panel.clear();
			void this.openerService.open(URI.file('/System/Applications/Utilities/Activity Monitor.app'), { openExternal: true });
		};
		const sleep = DOM.append(foot, DOM.$('button.dispatch-status-pill.solid', undefined, asked ? localize('dispatchStatusBar.sleeping', "Going to sleep…") : localize('dispatchStatusBar.letSleep', "Let Idle Agents Sleep"))) as HTMLButtonElement;
		sleep.disabled = asked;
		sleep.onclick = async e => {
			DOM.EventHelper.stop(e, true);
			sleep.disabled = true;
			sleep.textContent = localize('dispatchStatusBar.sleeping', "Going to sleep…");
			const r = await this.commandService.executeCommand<{ ok?: boolean }>('dispatch.busy', 'sleep').catch(() => undefined);
			if (r?.ok) {
				this.sleepAsked = Date.now();
			}
			this.panel.clear();
			this.togglePanel('busy', this.busy);
		};
		return panel;
	}

	// ---- an update is ready ---------------------------------------------------------------------

	private readyVersion(): string | undefined {
		const s = this.updateState;
		if (s.type !== UpdateStateType.Ready) {
			return undefined;
		}
		const v = s.update.productVersion || s.update.version;
		return this.storageService.get(LATER_KEY, StorageScope.APPLICATION) === v ? undefined : v;
	}

	private drawUpdate(): void {
		const el = this.update;
		const v = this.readyVersion();
		el.hidden = !v;
		if (!v) {
			if (this.panelKind === 'update') {
				this.panel.clear();
			}
			return;
		}
		DOM.clearNode(el);
		const bk = DOM.append(el, DOM.$('span.dispatch-status-bk'));
		bk.append(upGlyph(12));
		DOM.append(el, DOM.$('span.dispatch-status-text', undefined, this.narrow
			? localize('dispatchStatusBar.restartShort', "Restart")
			: localize('dispatchStatusBar.restartTo', "Restart to update")));
		el.setAttribute('aria-label', this.updateTip());
	}

	private updateTip(): string {
		return localize('dispatchStatusBar.updateTip', "Dispatch {0} is ready. Restart to use it.", this.readyVersion() ?? '');
	}

	private updatePanel(): HTMLElement {
		const v = this.readyVersion() ?? '';
		const panel = DOM.$('.dispatch-status-panel.update', { 'aria-label': localize('dispatchStatusBar.updatePanel', "Update") });
		const row = DOM.append(panel, DOM.$('.dispatch-status-prow.top'));
		const lead = DOM.append(row, DOM.$('span.dispatch-status-plead'));
		lead.append(upGlyph(20));
		const t = DOM.append(row, DOM.$('.dispatch-status-prow-text'));
		DOM.append(t, DOM.$('span.dispatch-status-prow-title', undefined, localize('dispatchStatusBar.updateReady', "Dispatch {0} is ready", v)));
		DOM.append(t, DOM.$('span.dispatch-status-prow-sub', undefined, localize('dispatchStatusBar.updateWhy', "Restart to use it. Every session picks up where it was, and What's new shows what changed.")));
		const foot = DOM.append(panel, DOM.$('.dispatch-status-pfoot.buttons'));
		const later = DOM.append(foot, DOM.$('button.dispatch-status-pill', undefined, localize('dispatchStatusBar.later', "Later")));
		later.onclick = e => {
			DOM.EventHelper.stop(e, true);
			// not again for this version; it installs anyway the next time Dispatch starts
			this.storageService.store(LATER_KEY, v, StorageScope.APPLICATION, StorageTarget.MACHINE);
			this.panel.clear();
			this.drawUpdate();
		};
		const restart = DOM.append(foot, DOM.$('button.dispatch-status-pill.solid', undefined, localize('dispatchStatusBar.restart', "Restart")));
		restart.onclick = e => {
			DOM.EventHelper.stop(e, true);
			this.panel.clear();
			void this.updateService.quitAndInstall();
		};
		return panel;
	}

	// ---- allowance ------------------------------------------------------------------------------

	private drawAllowance(): void {
		// setNarrow draws everything while the constructor runs, before the accounts model is there when the window
		// starts narrow; its onDidChange draws this again once it is
		const engines = (this.accounts?.engines ?? []).filter(x => x.signed_in);
		for (const [engine, el] of this.allowanceItems) {
			if (!engines.some(e => e.engine === engine)) {
				el.hidden = true;
			}
		}
		for (const e of engines) {
			let el = this.allowanceItems.get(e.engine);
			if (!el) {
				const engine = e.engine;
				el = this.item(this.allowance, `allowance-${engine}`, () => {
					const now = this.accounts.engines?.find(x => x.engine === engine);
					return now ? this.allowanceTip(now) : '';
				}, () => this.toggleAccounts(this.allowanceItems.get(engine)!));
				this.allowanceItems.set(engine, el);
			}
			DOM.clearNode(el);
			el.hidden = false;
			const wins = liveWindows(e.windows);
			// a Turbo run on this agent: a bolt before it, and what the run still plans to use striped
			const turbo = dispatchTurboHooks.live;
			const mine = turboGoing(turbo) && turbo.engine === e.engine ? turbo : undefined;
			el.classList.toggle('turbo', !!mine);
			if (mine) {
				DOM.append(el, DOM.$(`span.dispatch-status-turbo${ThemeIcon.asCSSSelector(Codicon.zap)}`));
			}
			DOM.append(el, DOM.$(`span.dispatch-status-engine${ThemeIcon.asCSSSelector(engineIcon(e.engine))}`));
			el.classList.toggle('unknown', !wins.length);
			if (!wins.length) {
				el.classList.remove('hot');
				DOM.append(el, DOM.$('span.dispatch-status-text', undefined, '–'));
				this.word(el, engineName(e.engine));
			} else {
				const top = wins.reduce((x, y) => pct(y) > pct(x) ? y : x);
				const used = pct(top);
				const w = allowanceWords(used, top.resets ?? '', engineName(e.engine), {
					narrow: this.narrow, newUser: this.newUser, usedWord: localize('dispatchStatusBar.used', "used"),
					resetsWord: when => localize('dispatchStatusBar.resetsWhen', "resets {0}", when),
				});
				el.append(gauge(used, this.narrow ? 5 : 10, w.low, mine ? Math.min(100 - used, mine.plans_more ?? 0) : 0));
				if (w.words) {
					DOM.append(el, DOM.$(w.low ? 'span.dispatch-status-text' : 'span.dispatch-status-word', undefined, w.words));
				}
				el.classList.toggle('hot', w.low);
			}
			el.setAttribute('aria-label', this.allowanceTip(e));
		}
	}

	private allowanceTip(e: IEngineStatus): string {
		const tip = this.allowanceTipBase(e);
		const turbo = dispatchTurboHooks.live;
		if (!turboGoing(turbo) || turbo.engine !== e.engine) {
			return tip;
		}
		const run = turbo.paused
			? localize('dispatchStatusBar.turboStopped', "A Turbo run on {0} stopped for this allowance; it carries on when it refills.", engineName(e.engine))
			: turbo.plans_more
				? localize('dispatchStatusBar.turboPlans', "A Turbo run is using this: about {0}% more until it is done (the striped part).", turbo.plans_more)
				: localize('dispatchStatusBar.turboUses', "A Turbo run is using this.");
		const lines = tip.split('\n');
		lines.splice(Math.max(1, lines.length - 1), 0, run);
		return lines.join('\n');
	}

	private allowanceTipBase(e: IEngineStatus): string {
		const who = e.account?.name ? `${engineName(e.engine)} (${e.account.name})` : engineName(e.engine);
		const wins = liveWindows(e.windows);
		if (!wins.length) {
			return `${localize('dispatchStatusBar.noUsage', "{0}: no usage numbers yet", who)}\n${localize('dispatchStatusBar.accountsClick', "Click to see your accounts and switch.")}`;
		}
		const lines = wins.map(w => w.resets
			? localize('dispatchStatusBar.windowUsedResets', "{0}: {1}% used, resets {2}", longWindow(w), pct(w), w.resets)
			: localize('dispatchStatusBar.windowUsed', "{0}: {1}% used", longWindow(w), pct(w)));
		return [who, ...lines, localize('dispatchStatusBar.accountsClick', "Click to see your accounts and switch.")].join('\n');
	}

	private toggleAccounts(anchor: HTMLElement): void {
		if (this.panel.value && this.panelKind === 'accounts') {
			this.panel.clear();
			return;
		}
		const store = new DisposableStore();
		this.panel.value = store;
		this.panelKind = 'accounts';
		showDispatchAccountsPanel(this.instantiationService, this.hoverService, this.accounts, anchor, HoverPosition.ABOVE, store, () => this.panel.clear());
	}

	// ---- panels -----------------------------------------------------------------------------------

	private togglePanel(kind: PanelKind, anchor: HTMLElement): void {
		if (this.panel.value && this.panelKind === kind) {
			this.panel.clear();
			return;
		}
		this.hoverService.hideHover(true);
		const store = new DisposableStore();
		this.panel.value = store;
		this.panelKind = kind;
		anchor.classList.add('open');
		store.add(toDisposable(() => {
			anchor.classList.remove('open');
			this.hoverService.hideHover(true);
		}));
		const content = kind === 'builds' ? this.buildsPanel() : kind === 'busy' ? this.busyPanel() : kind === 'update' ? this.updatePanel() : this.awakePanel();
		const hover = this.hoverService.showInstantHover({
			content,
			target: anchor,
			additionalClasses: ['dispatch-status-panel-hover'],
			position: { hoverPosition: HoverPosition.ABOVE },
			persistence: { sticky: true, hideOnHover: false },
			appearance: { showPointer: false, skipFadeInAnimation: true, maxHeightRatio: 0.8 },
		}, true);
		if (!hover) {
			this.panel.clear();
			return;
		}
		store.add(hover);
		store.add(DOM.addDisposableListener(mainWindow.document, DOM.EventType.KEY_DOWN, e => {
			if (e.key === 'Escape') {
				this.panel.clear();
			}
		}, true));
		const timer = mainWindow.setInterval(() => {
			if (!content.isConnected || hover.isDisposed) {
				this.panel.clear();
			}
		}, 400);
		store.add(toDisposable(() => mainWindow.clearInterval(timer)));
		if (kind === 'awake') {
			this.awakeOpen = true;
			store.add(toDisposable(() => {
				this.awakeOpen = false;
				this.awakePanelDraw = undefined;
				this.drawAwake();
			}));
		}
		if (kind === 'builds') {
			// looking at the failures is enough: the block with words goes away once the panel closes (while it is
			// open it is the panel's anchor; a hidden anchor took the panel with it)
			const shown = (this.queue?.failed ?? []).map(f => f.name);
			store.add(toDisposable(() => {
				shown.forEach(n => this.seenFailures.add(n));
				this.seenFailures = new Set([...this.seenFailures].slice(-200));
				this.storageService.store(SEEN_FAILURES_KEY, JSON.stringify([...this.seenFailures]), StorageScope.APPLICATION, StorageTarget.MACHINE);
				this.drawBuilds();
			}));
		}
	}

	private panelRow(parent: HTMLElement, lead: HTMLElement, title: string, sub: string, action?: { label: string; run: () => void; title?: string } | { label: string; run: () => void; title?: string }[]): HTMLElement {
		const row = DOM.append(parent, DOM.$('.dispatch-status-prow'));
		DOM.append(row, lead);
		const t = DOM.append(row, DOM.$('.dispatch-status-prow-text'));
		DOM.append(t, DOM.$('span.dispatch-status-prow-title', { title }, title));
		if (sub) {
			DOM.append(t, DOM.$('span.dispatch-status-prow-sub', undefined, sub));
		}
		for (const a of Array.isArray(action) ? action : action ? [action] : []) {
			const b = DOM.append(row, DOM.$('button.dispatch-status-pill', a.title ? { title: a.title } : undefined, a.label));
			b.onclick = e => {
				DOM.EventHelper.stop(e, true);
				a.run();
			};
		}
		return row;
	}

	private logAction(b: IDispatchBuild): { label: string; run: () => void } {
		return {
			label: localize('dispatchStatusBar.log', "Log"),
			run: () => {
				this.panel.clear();
				void this.commandService.executeCommand('dispatch.builds', 'log', b.name);
			},
		};
	}

	/** A failed build of yours: where it stopped, the last thing its log said, where the log is, Log and Try again. */
	private failedRow(body: HTMLElement, f: IDispatchBuild): void {
		const lead = DOM.$(`span.dispatch-status-plead${ThemeIcon.asCSSSelector(Codicon.warning)}`);
		const actions: { label: string; run: () => void; title?: string }[] = [this.logAction(f)];
		if (f.retry) {
			actions.push({
				label: localize('dispatchStatusBar.tryAgain', "Try again"),
				title: localize('dispatchStatusBar.retryHow', "Builds the same commit again from scratch ({0})", f.retry),
				run: () => {
					this.panel.clear();
					void this.commandService.executeCommand('dispatch.builds', 'retry', f.name);
				},
			});
		}
		const row = this.panelRow(body, lead, f.label, localize('dispatchStatusBar.failedAgo', "{0} · {1} ago", stepWords(f), duration(f.ago)), actions);
		row.classList.add('failed', 'top');
		const t = row.querySelector<HTMLElement>('.dispatch-status-prow-text')!;
		if (f.why) {
			DOM.append(t, DOM.$('span.dispatch-status-prow-why', { title: f.why }, f.stage === 'checks'
				? localize('dispatchStatusBar.failedScenarios', "Failed: {0}", f.why)
				: f.why));
		}
		if (f.log) {
			DOM.append(t, DOM.$('span.dispatch-status-prow-sub.dispatch-status-prow-log', { title: f.log }, localize('dispatchStatusBar.logAt', "Log: {0}", logPlace(f))));
		}
	}

	/** Builds running, just built and waiting, in either group. */
	private buildRows(body: HTMLElement, l: IDispatchBuildLists, where: (b: IDispatchBuild, text: string) => string, estimate: number | undefined): void {
		for (const d of l.done) {
			const lead = DOM.$('span.dispatch-status-qb.done');
			DOM.append(lead, DOM.$(`span${ThemeIcon.asCSSSelector(Codicon.check)}`));
			this.panelRow(body, lead, d.label, localize('dispatchStatusBar.builtNow', "Built just now"));
		}
		for (const b of l.building) {
			const lead = DOM.$('span.dispatch-status-qb.run');
			const fill = DOM.append(lead, DOM.$('i'));
			if (b.stage === 'checks') {
				lead.classList.add('checks');
				fill.style.height = '100%';
				this.panelRow(body, lead, b.label, where(b, localize('dispatchStatusBar.runningChecks', "Built, its checks are running")), this.logAction(b));
			} else {
				const est = b.estimate ?? estimate ?? 480;
				const secs = b.seconds ?? 0;
				fill.style.height = `${Math.round(Math.max(0.06, Math.min(0.94, secs / est)) * 100)}%`;
				const more = Math.max(0, est - secs);
				this.panelRow(body, lead, b.label, where(b, more > 30
					? localize('dispatchStatusBar.buildingFor', "{0} · about {1} more", duration(secs), duration(more))
					: localize('dispatchStatusBar.buildingAlmost', "{0} · almost done", duration(secs))), this.logAction(b));
			}
		}
		if (l.waiting.length) {
			DOM.append(body, DOM.$('.dispatch-status-psub', undefined, localize('dispatchStatusBar.waitingCount', "Waiting · {0}", l.waiting.length)));
			for (const w of l.waiting) {
				const row = this.panelRow(body, DOM.$('span.dispatch-status-qb'), w.label, '');
				row.classList.add('waiting');
				DOM.append(row, DOM.$('span.dispatch-status-prow-aside', { title: localize('dispatchStatusBar.waitedFor', "Waiting for {0}", duration(w.waited)) }, where(w, duration(w.waited))));
			}
		}
	}

	private buildsPanel(): HTMLElement {
		const q = this.queue;
		const panel = DOM.$('.dispatch-status-panel.builds', { 'aria-label': localize('dispatchStatusBar.buildsPanel', "Builds") });
		const head = DOM.append(panel, DOM.$('.dispatch-status-phead'));
		DOM.append(head, DOM.$('span', undefined, localize('dispatchStatusBar.buildsTitle', "Builds")));
		DOM.append(head, DOM.$('span.dispatch-status-phead-aside', undefined, localize('dispatchStatusBar.oneAtATime', "One at a time on each Mac")));
		const count = (l: IDispatchBuildLists) => l.building.length + l.waiting.length + l.failed.length + l.done.length;
		if (!q || (!count(q) && !count(q.agents))) {
			DOM.append(panel, DOM.$('.dispatch-status-pempty', undefined, localize('dispatchStatusBar.buildsEmpty', "Nothing is building. A build an agent starts shows here until it is done.")));
			return panel;
		}
		const hosts = new Set([...q.building, ...q.waiting, ...q.agents.building, ...q.agents.waiting].map(b => b.host));
		const where = (b: IDispatchBuild, text: string) => hosts.size > 1 ? `${text} · ${hostName(b.host)}` : text;
		const body = DOM.append(panel, DOM.$('.dispatch-status-pbody'));
		if (!count(q)) {
			DOM.append(body, DOM.$('.dispatch-status-pempty', undefined, localize('dispatchStatusBar.noneOfYours', "None of your builds is running.")));
		}
		for (const f of q.failed) {
			this.failedRow(body, f);
		}
		this.buildRows(body, q, where, q.estimate);
		// the agents' test builds: folded, no warnings; what failed there is the agent's to fix, not yours
		const a = q.agents;
		const n = count(a);
		if (n) {
			const group = DOM.append(body, DOM.$('.dispatch-status-pgroup'));
			const toggle = DOM.append(group, DOM.$('button.dispatch-status-pgroup-head', { 'aria-expanded': String(this.agentsOpen) }));
			const chevron = DOM.append(toggle, DOM.$(`span${ThemeIcon.asCSSSelector(this.agentsOpen ? Codicon.chevronDown : Codicon.chevronRight)}`));
			DOM.append(toggle, DOM.$('span', undefined, localize('dispatchStatusBar.agentsGroup', "Agents' test builds · {0}", n)));
			const inner = DOM.append(group, DOM.$('.dispatch-status-pgroup-body'));
			inner.hidden = !this.agentsOpen;
			DOM.append(inner, DOM.$('.dispatch-status-pnote', undefined, localize('dispatchStatusBar.agentsNote', "Builds agents make to try their changes. Nothing here needs you.")));
			this.buildRows(inner, a, where, q.estimate);
			for (const f of a.failed) {
				const row = this.panelRow(inner, DOM.$('span.dispatch-status-qb'), f.label, f.stage === 'checks'
					? localize('dispatchStatusBar.agentChecks', "Didn't pass its checks · {0} ago", duration(f.ago))
					: localize('dispatchStatusBar.agentDidNotBuild', "Didn't build · {0} ago", duration(f.ago)), this.logAction(f));
				row.classList.add('quiet');
			}
			toggle.onclick = e => {
				DOM.EventHelper.stop(e, true);
				this.agentsOpen = !this.agentsOpen;
				inner.hidden = !this.agentsOpen;
				toggle.setAttribute('aria-expanded', String(this.agentsOpen));
				chevron.className = ThemeIcon.asClassName(this.agentsOpen ? Codicon.chevronDown : Codicon.chevronRight);
			};
		}
		const r = q.recent;
		if (r && (r.built || r.failed || r.checks_failed)) {
			const parts = [localize('dispatchStatusBar.todayBuilt', "{0} built", r.built)];
			if (r.failed) {
				parts.push(localize('dispatchStatusBar.todayFailed', "{0} didn't build", r.failed));
			}
			if (r.checks_failed) {
				parts.push(localize('dispatchStatusBar.todayChecks', "{0} failed their checks", r.checks_failed));
			}
			DOM.append(panel, DOM.$('.dispatch-status-pfoot', undefined, localize('dispatchStatusBar.todayYours', "Your builds, last 24 hours: {0}", parts.join(', '))));
		}
		return panel;
	}

	/** The cup's panel: what is held and why, and the two switches of Settings › Keep awake right here (the same
	 *  `dispatch.keepAwake`; the page has nothing more to set). A switch takes at once, and the words follow it. */
	private awakePanel(): HTMLElement {
		const panel = DOM.$('.dispatch-status-panel.awake', { 'aria-label': localize('dispatchStatusBar.awakePanel', "Keep awake") });
		const row = DOM.append(panel, DOM.$('.dispatch-status-prow.top'));
		const lead = DOM.append(row, DOM.$('span.dispatch-status-plead'));
		lead.append(cup(20));
		const t = DOM.append(row, DOM.$('.dispatch-status-prow-text'));
		const head = DOM.append(t, DOM.$('span.dispatch-status-prow-title'));
		const sub = DOM.append(t, DOM.$('span.dispatch-status-prow-sub'));

		const switches = DOM.append(panel, DOM.$('.dispatch-awake-switches'));
		const set = async (mode: AwakeMode) => {
			const now = this.awakeMode();
			if (mode === now) {
				return;
			}
			if (mode === 'off') {
				this.awakeLastOn = now;
			}
			this.awakePending = mode;
			draw();
			try {
				await this.configurationService.updateValue('dispatch.keepAwake', mode, ConfigurationTarget.USER);
			} finally {
				this.awakePending = undefined;
			}
		};
		const keep = this.awakeSwitch(switches, 'keep',
			localize('dispatchStatusBar.awakeKeep', "Keep the Mac awake"),
			localize('dispatchStatusBar.awakeKeepSub', "While agents work or your phone is connected"),
			on => set(on ? this.awakeLastOn : 'off'));
		const screen = this.awakeSwitch(switches, 'screen',
			localize('dispatchStatusBar.awakeScreen', "Keep the screen on too"),
			localize('dispatchStatusBar.awakeScreenSub', "For a Mac you watch from across the room"),
			on => set(on ? 'display' : 'system'));
		DOM.append(panel, DOM.$('.dispatch-status-pnote.dispatch-awake-lid', undefined,
			localize('dispatchStatusBar.awakeLid', "Closing the lid still puts a MacBook to sleep, unless it is on power with an outside display.")));

		const draw = () => {
			const mode = this.awakeMode();
			const words = awakeWords(this.awakeState, this.working, mode);
			panel.dataset.mode = mode;
			lead.classList.toggle('working', mode !== 'off' && awakeWorking(this.awakeState, this.working) > 0);
			lead.classList.toggle('off', mode === 'off');
			head.textContent = words.head;
			sub.textContent = words.count ? `${words.why} ${words.count}` : words.why;
			keep(mode !== 'off', true);
			// while the Mac may sleep the screen switch shows what it goes back to, and waits
			screen(mode === 'off' ? this.awakeLastOn === 'display' : mode === 'display', mode !== 'off');
		};
		this.awakePanelDraw = draw;
		draw();
		return panel;
	}

	/** A row with the square switch (as the Inbox's), its label and a line under it; the whole row flips it.
	 *  Returns how to show it: on or off, and whether it can be flipped now. */
	private awakeSwitch(parent: HTMLElement, id: string, label: string, sub: string, flip: (on: boolean) => Promise<void>): (on: boolean, enabled: boolean) => void {
		const row = DOM.append(parent, DOM.$<HTMLButtonElement>('button.dispatch-awake-switch-row', { type: 'button', role: 'switch' }));
		row.dataset.awake = id;
		const sw = DOM.append(row, DOM.$('span.dispatch-awake-switch'));
		DOM.append(sw, DOM.$('span.dispatch-awake-switch-thumb'));
		const t = DOM.append(row, DOM.$('span.dispatch-awake-switch-text'));
		DOM.append(t, DOM.$('span.dispatch-awake-switch-label', undefined, label));
		DOM.append(t, DOM.$('span.dispatch-awake-switch-sub', undefined, sub));
		row.setAttribute('aria-label', label);
		row.onclick = e => {
			DOM.EventHelper.stop(e, true);
			if (row.disabled) {
				return;
			}
			const want = row.getAttribute('aria-checked') !== 'true';
			row.setAttribute('aria-checked', String(want)); // at once; the words follow once the setting has it
			void flip(want).finally(() => this.awakePanelDraw?.());
		};
		return (on, enabled) => {
			row.setAttribute('aria-checked', String(on));
			row.disabled = !enabled;
		};
	}
}

registerWorkbenchContribution2(DispatchStatusBar.ID, DispatchStatusBar, WorkbenchPhase.AfterRestored);

type RareBlocks = 'busy' | 'update' | 'both' | 'real';
let previewRareBlocks: ((what: RareBlocks) => Promise<void>) | undefined;

// Developer: Preview the Bottom Bar's Rare Blocks (Busy, Restart to update): how they look and what their panels do,
// on a Mac that is not busy and has no update waiting (the end-to-end checks use it too)
registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dispatch.statusBar.previewRareBlocks', title: localize2('dispatchStatusBar.preview', "Preview the Bottom Bar's Rare Blocks"), category: localize2('developer', "Developer"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const pick = await accessor.get(IQuickInputService).pick<{ label: string; id: RareBlocks }>([
			{ id: 'busy', label: localize('dispatchStatusBar.previewBusy', "Mac is busy") },
			{ id: 'update', label: localize('dispatchStatusBar.previewUpdate', "An update is ready") },
			{ id: 'both', label: localize('dispatchStatusBar.previewBoth', "Both") },
			{ id: 'real', label: localize('dispatchStatusBar.previewReal', "Back to what is true") },
		], { placeHolder: localize('dispatchStatusBar.previewPick', "Which blocks to show") });
		if (pick) {
			await previewRareBlocks?.(pick.id);
		}
	}
});
