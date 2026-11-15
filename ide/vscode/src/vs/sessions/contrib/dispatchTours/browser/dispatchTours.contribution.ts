/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: tips that point at the real thing, and the Getting started checklist (kanban task
 *  "弹窗提示引导", design/orca-study G4 and G7; patches/475-tours.patch). The rules are in
 *  dispatchToursModel.ts, the tips and the list in dispatchToursData.ts.
 *
 *  - A tour is a bubble on a UI element (dispatchToursBubble.ts) that shows the first time the person
 *    reaches its place: the element is on screen, no first-run setup, no dialog, menu, What's new card
 *    or other tip over the window, none ended a moment ago. Closing or finishing it means seen, kept
 *    per profile; it never comes back by itself.
 *  - Replay: Help > Replay Tips forgets what was seen. Help > Getting Started opens the checklist.
 *  - Getting started (dispatchChecklist.ts): eight things to try, each ticks when it is really done.
 *    Its entry sits in the title bar next to What's new, with a progress ring.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Menus } from '../../../browser/menus.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { DispatchChecklist, DispatchChecklistCard, setDispatchChecklistEntry } from './dispatchChecklist.js';
import { DISPATCH_TOURS, IDispatchChecklistItem } from './dispatchToursData.js';
import { blockingSurface, findOnScreen, isOnScreen, rectOf } from './dispatchToursDom.js';
import { DispatchTourBubble, keepClearRects } from './dispatchToursBubble.js';
import { IDispatchTour, IDispatchTourAnchor, IDispatchTourStep, nextVisibleStepIndex, pickTour, previousVisibleStepIndex, sameRect, stepProgress, tourDecision, visibleStepIndexes } from './dispatchToursModel.js';
import { DispatchToursState } from './dispatchToursState.js';

const ONBOARDING_VIEW_ID = 'dispatch.onboarding';
const TIPS_SETTING = 'dispatch.tips.enabled';

const REPLAY_COMMAND = 'dispatch.tours.replay';
const START_COMMAND = 'dispatch.tours.start';
const CHECKLIST_SHOW_COMMAND = 'dispatch.checklist.show';
const CHECKLIST_TOGGLE_COMMAND = 'dispatch.checklist.toggle';
const TIPS_OFF_COMMAND = 'dispatch.tips.turnOff';
const TIPS_ON_COMMAND = 'dispatch.tips.turnOn';

const ChecklistVisible = new RawContextKey<boolean>('dispatchChecklistVisible', false);

/** Nothing shows for this long after a window opens: the first-run setup decides first. */
const START_DELAY_MS = 6000;
/** The setup page was due but never opened (something is wrong with it): tips go on. */
const SETUP_WAIT_MS = 45_000;
const SCAN_MS = 800;
const TRACK_MS = 100;
/** The element is gone for this long: the step is over. */
const LOST_MS = 1200;
const POLL_MS = 60_000;

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'dispatchTips',
	title: localize('dispatchTours.settingsTitle', "Tips"),
	type: 'object',
	properties: {
		[TIPS_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('dispatchTours.setting', "Show a short tip the first time you reach a part of Dispatch that is easy to miss."),
		},
	},
});

interface IRun {
	readonly tour: IDispatchTour;
	/** A tip for one thing, started from the checklist: not remembered as seen. */
	readonly ephemeral: boolean;
	stepIndex: number;
	bubble: DispatchTourBubble | undefined;
	anchorEl: HTMLElement | undefined;
	lastRect: ReturnType<typeof rectOf> | undefined;
	lastClear?: string;
	lostSince: number | undefined;
	readonly store: DisposableStore;
}

let contribution: DispatchToursContribution | undefined;

class DispatchToursContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dispatchTours';

	private readonly state: DispatchToursState;
	private readonly checklist: DispatchChecklist;
	private readonly card: DispatchChecklistCard;
	private readonly visible: IContextKey<boolean>;
	private run: IRun | undefined;
	private lastEndedAt: number | undefined;
	private wizardActive = false;
	/** The first-run setup has not run yet on this Mac (Dispatch said so), or is not over. */
	private setupAhead = false;
	private wizardSeen = false;
	/** Whether Dispatch has answered if the first-run setup is due: nothing shows before. */
	private setupKnown = false;
	private readonly openedAt = Date.now();

	constructor(
		@IStorageService storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICustomViewService customViewService: ICustomViewService,
		@ISessionsManagementService sessionsManagement: ISessionsManagementService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@IHoverService hoverService: IHoverService,
		@INotificationService private readonly notificationService: INotificationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IActionViewItemService actionViewItemService: IActionViewItemService,
	) {
		super();
		contribution = this;
		this._register({ dispose: () => { contribution = undefined; setDispatchChecklistEntry(undefined, undefined); } });
		this.state = this._register(new DispatchToursState(storageService));
		this.checklist = this._register(new DispatchChecklist(this.state, commandService, sessionsManagement));
		this.card = this._register(new DispatchChecklistCard(this.checklist, hoverService, {
			showMe: item => this.showMe(item),
			hide: () => this.hideChecklist(),
		}));

		// the entry in the title bar, right of What's new (order 3) and Set up (order 4)
		this.visible = ChecklistVisible.bindTo(contextKeyService);
		const syncVisible = () => this.visible.set(!this.state.checklistHidden && !this.wizardActive);
		this._register(this.state.onDidChange(syncVisible));
		this._register(autorun(reader => {
			this.wizardActive = customViewService.activeCustomView.read(reader)?.id === ONBOARDING_VIEW_ID;
			if (this.wizardActive) {
				this.wizardSeen = true;
				this.lastEndedAt = Date.now();
			} else if (this.wizardSeen) {
				// the setup page is over (finished or skipped)
				this.setupAhead = false;
				this.lastEndedAt = Date.now();
			}
			syncVisible();
		}));
		// the setup page opens a moment after the window does: ask whether it is due before any tip may show
		commandService.executeCommand<{ needed?: boolean }>('dispatch.onboarding', 'status').then(
			status => { this.setupAhead = !!status?.needed && !this.wizardSeen; },
			() => undefined,
		).finally(() => { this.setupKnown = true; });
		setDispatchChecklistEntry(this.checklist, anchor => this.card.toggle(anchor));
		// the entry is the Getting started block in the bottom bar while `dispatchChecklistVisible` (contrib/dispatchStatusBar)

		this._register(this.checklist.onDidComplete(() => this.celebrate()));
		this._register(sessionsManagement.onDidSendRequest(e => {
			this.checklist.onRequest(!!e.session.isQuickChat?.get() || !e.session.workspace.get());
		}));
		this._register(commandService.onDidExecuteCommand(e => this.checklist.onCommand(e.commandId)));

		const scan = mainWindow.setInterval(() => this.scan(), SCAN_MS);
		this._register({ dispose: () => mainWindow.clearInterval(scan) });
		const poll = mainWindow.setInterval(() => void this.checklist.poll(), POLL_MS);
		this._register({ dispose: () => mainWindow.clearInterval(poll) });
		const first = mainWindow.setTimeout(() => void this.checklist.poll(), START_DELAY_MS);
		this._register({ dispose: () => mainWindow.clearTimeout(first) });
		this._register({ dispose: () => this.endRun(false) });
	}

	// ---------------------------------------------------------------- what is on screen, what may start

	private get enabled(): boolean {
		return this.configurationService.getValue<boolean>(TIPS_SETTING) !== false;
	}

	private readonly onScreen = (anchor: IDispatchTourAnchor): boolean => !!findOnScreen(mainWindow.document, anchor);

	private scan(): void {
		const doc = mainWindow.document;
		if (doc.visibilityState !== 'visible') {
			return;
		}
		this.checklist.scanDom(doc);
		if (this.setupAhead && !this.wizardSeen && Date.now() - this.openedAt > SETUP_WAIT_MS) {
			this.setupAhead = false;
		}
		if (this.run || !this.setupKnown || Date.now() - this.openedAt < START_DELAY_MS) {
			return;
		}
		const surface = blockingSurface(doc);
		const pick = pickTour(DISPATCH_TOURS, tour => tourDecision({
			tour,
			enabled: this.enabled,
			wizardVisible: this.wizardActive || this.setupAhead,
			seenIds: this.state.seen,
			activeTourId: null,
			lastEndedAt: this.lastEndedAt,
			now: Date.now(),
			blockingSurface: surface,
			targetExists: this.onScreen,
		}));
		if (pick) {
			this.start(pick.tour, pick.stepIndex, false);
		}
	}

	// ---------------------------------------------------------------- a run

	private start(tour: IDispatchTour, stepIndex: number, ephemeral: boolean): void {
		this.endRun(false);
		const run: IRun = { tour, ephemeral, stepIndex, bubble: undefined, anchorEl: undefined, lastRect: undefined, lostSince: undefined, store: new DisposableStore() };
		this.run = run;
		const doc = mainWindow.document;
		const timer = mainWindow.setInterval(() => this.track(run), TRACK_MS);
		run.store.add({ dispose: () => mainWindow.clearInterval(timer) });
		// the real thing is the point: pressing the element a step shows moves the tip on. A tab acts on the
		// press and draws itself again, so no click comes after it: the press counts, the click too.
		let advancing = false;
		const pressed = (e: MouseEvent) => {
			const step = tour.steps[run.stepIndex];
			if (!advancing && step?.advanceOnClick && run.anchorEl?.contains(e.target as Node) && !run.bubble?.contains(e.target)) {
				advancing = true;
				mainWindow.setTimeout(() => { advancing = false; this.advance(run); }, 80);
			}
		};
		run.store.add(dom.addDisposableListener(doc, dom.EventType.MOUSE_DOWN, pressed, true));
		run.store.add(dom.addDisposableListener(doc, dom.EventType.CLICK, pressed, true));
		run.store.add(dom.addDisposableListener(doc, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Escape' && run.bubble?.hasFocus()) {
				e.preventDefault();
				e.stopPropagation();
				this.endRun(true);
			}
		}, true));
		this.showStep(run, stepIndex, true);
	}

	private showStep(run: IRun, stepIndex: number, animate: boolean): void {
		const doc = mainWindow.document;
		const step = run.tour.steps[stepIndex];
		const el = step && findOnScreen(doc, step.anchor);
		if (!step || !el) {
			// not on screen after all: the next step that is, or the end
			const next = nextVisibleStepIndex(run.tour, stepIndex, this.onScreen);
			if (next === undefined || next === stepIndex) {
				this.endRun(!run.ephemeral && run.bubble !== undefined);
			} else {
				this.showStep(run, next, animate);
			}
			return;
		}
		run.bubble?.dispose();
		run.stepIndex = stepIndex;
		run.anchorEl = el;
		run.lostSince = undefined;
		const visible = visibleStepIndexes(run.tour, this.onScreen);
		const progress = stepProgress(visible, stepIndex) ?? { current: 1, total: 1 };
		const bubble = new DispatchTourBubble(this.layoutService.mainContainer, {
			step,
			position: progress.current,
			total: progress.total,
			isLast: nextVisibleStepIndex(run.tour, stepIndex, this.onScreen) === undefined,
		}, animate);
		run.bubble = bubble;
		run.store.add(bubble.onDidNext(() => this.advance(run)));
		run.store.add(bubble.onDidBack(() => {
			const prev = previousVisibleStepIndex(run.tour, run.stepIndex, this.onScreen);
			if (prev !== undefined) {
				this.showStep(run, prev, false);
			}
		}));
		run.store.add(bubble.onDidClose(() => this.endRun(true)));
		run.store.add(bubble.onDidAction(() => this.act(run, step)));
		run.lastRect = rectOf(el);
		bubble.place(run.lastRect, step.placement);
	}

	private advance(run: IRun): void {
		if (this.run !== run) {
			return;
		}
		const next = nextVisibleStepIndex(run.tour, run.stepIndex, this.onScreen);
		if (next === undefined) {
			this.endRun(true);
		} else {
			this.showStep(run, next, false);
		}
	}

	private act(run: IRun, step: IDispatchTourStep): void {
		const action = step.action;
		const el = run.anchorEl;
		this.endRun(true);
		if (!action) {
			return;
		}
		if (action.command) {
			void this.commandService.executeCommand(action.command, ...(action.args ?? []));
		} else {
			el?.click();
		}
	}

	/** Every 100 ms: follow the element (a pane that slides, a list that redraws), step aside for a menu, give up when it is gone. */
	private track(run: IRun): void {
		if (this.run !== run || !run.bubble) {
			return;
		}
		const doc = mainWindow.document;
		const step = run.tour.steps[run.stepIndex];
		let el = run.anchorEl;
		if (!el || !isOnScreen(el)) {
			el = findOnScreen(doc, step.anchor);
		}
		if (!el) {
			run.lostSince ??= Date.now();
			if (Date.now() - run.lostSince > LOST_MS) {
				const next = nextVisibleStepIndex(run.tour, run.stepIndex, this.onScreen);
				if (next === undefined) {
					this.endRun(!run.ephemeral && Date.now() - run.lostSince > LOST_MS);
				} else {
					this.showStep(run, next, false);
				}
			}
			return;
		}
		run.lostSince = undefined;
		run.anchorEl = el;
		const visible = visibleStepIndexes(run.tour, this.onScreen);
		const progress = stepProgress(visible, run.stepIndex) ?? { current: 1, total: 1 };
		run.bubble.setProgress({ position: progress.current, total: progress.total, isLast: nextVisibleStepIndex(run.tour, run.stepIndex, this.onScreen) === undefined });
		const surface = blockingSurface(doc);
		run.bubble.setHidden(!!surface);
		if (surface) {
			return;
		}
		const rect = rectOf(el);
		// the boxes a tip keeps clear of can show up after it (a page draws them a moment later)
		const clear = JSON.stringify(keepClearRects(doc));
		if (!sameRect(run.lastRect, rect) || run.lastClear !== clear || run.bubble.coversKeepClear()) {
			run.lastRect = rect;
			run.lastClear = clear;
			run.bubble.place(rect, step.placement);
		}
	}

	private endRun(markSeen: boolean): void {
		const run = this.run;
		if (!run) {
			return;
		}
		this.run = undefined;
		run.bubble?.dispose();
		run.store.dispose();
		if (markSeen && !run.ephemeral) {
			this.state.markSeen(run.tour.id);
		}
		this.lastEndedAt = Date.now();
	}

	// ---------------------------------------------------------------- what the menus and the list ask for

	/** A tip for one element, from the checklist's Show me. */
	private spot(step: IDispatchTourStep): void {
		const tour: IDispatchTour = { id: `spot:${step.id}`, order: 0, steps: [step] };
		if (!this.onScreen(step.anchor)) {
			this.notificationService.info(localize('dispatchTours.spotMissing', "It is not on screen right now. Open a session and try again."));
			return;
		}
		this.start(tour, 0, true);
	}

	private showMe(item: IDispatchChecklistItem): void {
		const show = item.show;
		if ('spot' in show) {
			this.spot(show.spot);
		} else {
			void this.commandService.executeCommand(show.command, ...(show.args ?? []));
		}
	}

	/** Help > Getting Started. */
	openChecklist(): void {
		this.state.setChecklistHidden(false);
		// the entry shows on the next frame
		mainWindow.setTimeout(() => {
			const entry = mainWindow.document.querySelector<HTMLElement>('.dispatch-checklist-entry');
			if (entry && !this.card.isOpen) {
				this.card.show(entry);
			}
		}, 150);
	}

	hideChecklist(): void {
		this.state.setChecklistHidden(true);
		this.notificationService.info(localize('dispatchChecklist.hidden', "Getting started is hidden. Bring it back from Help, Getting Started."));
	}

	private celebrate(): void {
		if (this.state.celebrated) {
			return;
		}
		this.state.setCelebrated();
		this.state.setChecklistHidden(true);
		this.notificationService.info(localize('dispatchChecklist.complete', "You have tried everything on the Getting started list. It stays in Help, Getting Started."));
	}

	/** Help > Replay Tips: forget what was shown; each tip comes again when you reach its place. */
	replay(): void {
		this.endRun(false);
		this.state.resetSeen();
		this.lastEndedAt = undefined;
		this.notificationService.info(localize('dispatchTours.replayed', "Tips will show again as you reach each part of Dispatch."));
	}

	/** A tour on request (a test's): even when it was seen. */
	startTour(id: string): boolean {
		const tour = DISPATCH_TOURS.find(t => t.id === id);
		if (!tour) {
			return false;
		}
		const d = tourDecision({
			tour, enabled: this.enabled, wizardVisible: this.wizardActive || this.setupAhead, seenIds: this.state.seen, activeTourId: null,
			now: Date.now(), blockingSurface: blockingSurface(mainWindow.document), targetExists: this.onScreen, forced: true,
		});
		if (d.kind !== 'start') {
			return false;
		}
		this.start(tour, d.stepIndex, true);
		return true;
	}

	setTipsEnabled(on: boolean): void {
		void this.configurationService.updateValue(TIPS_SETTING, on);
		if (!on) {
			this.endRun(false);
		}
		this.notificationService.info(on
			? localize('dispatchTours.on', "Tips are on. They show the first time you reach a part of Dispatch.")
			: localize('dispatchTours.off', "Tips are off. Turn them back on from Help, Turn On Tips."));
	}
}

registerWorkbenchContribution2(DispatchToursContribution.ID, DispatchToursContribution, WorkbenchPhase.AfterRestored);

// ---------------------------------------------------------------- Help menu and commands

const HELP_GROUP = '1_welcome';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CHECKLIST_SHOW_COMMAND,
			title: localize2('dispatchChecklist.helpEntry', "Getting Started"),
			f1: true,
			menu: { id: MenuId.MenubarHelpMenu, group: HELP_GROUP, order: 10 },
		});
	}
	run(): void {
		contribution?.openChecklist();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: REPLAY_COMMAND,
			title: localize2('dispatchTours.replayEntry', "Replay Tips"),
			f1: true,
			menu: { id: MenuId.MenubarHelpMenu, group: HELP_GROUP, order: 11 },
		});
	}
	run(): void {
		contribution?.replay();
	}
});

// the account menu (the avatar at the top right) has them too: the Mac menu bar's Help is out of sight in this window
MenuRegistry.appendMenuItem(Menus.AccountMenu, { command: { id: CHECKLIST_SHOW_COMMAND, title: localize('dispatchChecklist.accountEntry', "Getting Started") }, group: '3_help', order: 1 });
MenuRegistry.appendMenuItem(Menus.AccountMenu, { command: { id: REPLAY_COMMAND, title: localize('dispatchTours.accountReplay', "Replay Tips") }, group: '3_help', order: 2 });

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: TIPS_OFF_COMMAND,
			title: localize2('dispatchTours.turnOff', "Turn Off Tips"),
			f1: true,
			precondition: ContextKeyExpr.notEquals(`config.${TIPS_SETTING}`, false),
			menu: { id: MenuId.MenubarHelpMenu, group: HELP_GROUP, order: 12, when: ContextKeyExpr.notEquals(`config.${TIPS_SETTING}`, false) },
		});
	}
	run(): void {
		contribution?.setTipsEnabled(false);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: TIPS_ON_COMMAND,
			title: localize2('dispatchTours.turnOn', "Turn On Tips"),
			f1: true,
			precondition: ContextKeyExpr.equals(`config.${TIPS_SETTING}`, false),
			menu: { id: MenuId.MenubarHelpMenu, group: HELP_GROUP, order: 12, when: ContextKeyExpr.equals(`config.${TIPS_SETTING}`, false) },
		});
	}
	run(): void {
		contribution?.setTipsEnabled(true);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: START_COMMAND, title: localize2('dispatchTours.start', "Show a Tip"), f1: false });
	}
	run(_accessor: ServicesAccessor, id?: string): boolean {
		return !!id && !!contribution?.startTour(id);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: CHECKLIST_TOGGLE_COMMAND, title: localize2('dispatchChecklist.toggle', "Getting Started Checklist"), f1: false });
	}
	run(): void {
		contribution?.openChecklist();
	}
});
