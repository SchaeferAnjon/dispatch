/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Turbo (狂暴模式) (patches/420-turbo.patch; kanban design/frenzy direction A, the user's pick
 *  「Timeline run tab」).
 *
 *  - The Timeline is a page in the middle of the window (dispatchTimeline.ts): a Turbo run's parts as lanes, or without
 *    one the person's own sessions and their helpers. A run's row in the sessions list opens it (Turbo's own way in).
 *    Until 2026-11-11 it was a tab of the Assistant's home; the Assistant is gone (design/home-now direction A,
 *    task-0v1o9), its Chat and Timeline tabs with it. Since 2026-11-15 (user, task-ccmyi) the page has no way in of its
 *    own: not in the side bar, not in the Command Palette (`dispatch.turbo.timeline.open` stays, f1 off), until it is
 *    redone after the lanes picture the user liked on 2026-10-01 (design/from-m1/frenzy).
 *  - The Turbo switch under a new chat's input box (Chats' "+", where a job across projects is asked; a square check,
 *    DESIGN.md's Toggle). While it is on, the next message becomes a Turbo plan (`dispatch turbo plan`, which picks the
 *    project the message names, else the last one worked in) shown on the Timeline instead of a session; nothing runs
 *    before Start there. The first time it is turned on, one line says what it does. It turns itself off once it took
 *    a message.
 *  - The run that goes is read every few seconds (`dispatch turbo list`) for the rest of the window: its row under
 *    the project's folder in the sessions list (dispatchTurboSidebar.ts), the bolt and the stripes on the bottom
 *    bar's allowance and in the account menu (dispatchTurboHooks.ts `live`).
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchTurbo.css';
import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, constObservable, IObservable } from '../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { SessionsCategories } from '../../../common/categories.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { INewSessionComposerService } from '../../chat/browser/newSessionComposerService.js';
import { CheckboxChip } from '../../chat/browser/checkboxChip.js';
import { askTurbo, DispatchTimeline } from './dispatchTimeline.js';
import { ITurboRun } from './dispatchTurboModel.js';
import { DISPATCH_TIMELINE_OPEN, DISPATCH_TIMELINE_VIEW_ID as TIMELINE_VIEW_ID, dispatchTurboHooks, ITurboLive, ITurboPick, onDispatchTurboChange, setDispatchTurboHover, setDispatchTurboLive, turboEngineOf, turboModelOf } from './dispatchTurboHooks.js';

const EXPLAINED_KEY = 'dispatch.turbo.explained';

let controller: DispatchTurboHome | undefined;

type IRunRow = ITurboLive & { readonly done_at?: number | null };

/** The run the window shows elsewhere: one that goes, else one planned, else one that ended within the hour. */
function liveRun(rows: readonly IRunRow[]): IRunRow | undefined {
	const going = rows.find(r => ['running', 'paused', 'combining'].includes(r.state));
	return going ?? rows.find(r => r.state === 'planning' || r.state === 'planned') ?? rows.find(r => r.state === 'done' && !!r.parts);
}

/** The Timeline in the middle of the window: the controller's one Timeline, shown while the page is. */
class DispatchTimelineView extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('dispatchTurbo.timelineTitle', "Timeline"));
	override readonly maxWidth = 1100;

	render(container: HTMLElement): void {
		const timeline = controller?.timeline;
		if (!timeline) {
			return;
		}
		const page = dom.append(container, dom.$('.dispatch-timeline-page'));
		page.appendChild(timeline.element);
		timeline.start();
		this._register(toDisposable(() => {
			timeline.stop();
			timeline.element.remove();
			// the page goes with the pointer still on a lane (Esc, another page): no mouse leave comes, so the lane's
			// light in the sessions list goes here
			setDispatchTurboHover(undefined);
		}));
	}

	layout(_width: number, _height: number): void { }
}

class DispatchTurboHome extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessions.dispatchTurboHome';

	readonly timeline: DispatchTimeline;
	private on = false;
	private chip: CheckboxChip | undefined;
	private chipHost: HTMLElement | undefined;
	private note: HTMLElement | undefined;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService private readonly storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICustomViewService private readonly customViewService: ICustomViewService,
		@INewSessionComposerService composerService: INewSessionComposerService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		controller = this;
		this._register(toDisposable(() => { if (controller === this) { controller = undefined; } }));
		this._register(customViewService.registerCustomView({ id: TIMELINE_VIEW_ID, ctor: new SyncDescriptor(DispatchTimelineView) }, { restore: false }));
		this.timeline = this._register(instantiationService.createInstance(DispatchTimeline));
		this.timeline.onRun = run => {
			// the Timeline saw a change first (Start, a part combined, a stop): the rest of the window follows at once
			const live = dispatchTurboHooks.live;
			const parts = (r: { parts?: readonly { status: string }[] } | undefined) => (r?.parts ?? []).map(p => p.status).join();
			if (run && (run.id !== live?.id || run.state !== live?.state || run.combined !== live?.combined || run.needs.length !== (live?.needs ?? 0) || parts(run) !== parts(live))) {
				void this.readLive();
			}
		};
		dispatchTurboHooks.send = (query, pick) => this.takeSend(query, pick);
		this._register(toDisposable(() => { dispatchTurboHooks.send = undefined; }));
		// the run that goes, for the sessions list, the bottom bar and the account menu (a light read: the runs, not the
		// lanes): every 5 s while one goes, else every 30 s
		let timer: number | undefined;
		let fast = false;
		const going = () => ['running', 'paused', 'combining', 'planning'].includes(dispatchTurboHooks.live?.state ?? '');
		const next = () => {
			mainWindow.clearTimeout(timer);
			fast = going();
			timer = mainWindow.setTimeout(() => {
				if (mainWindow.document.visibilityState === 'visible') {
					void this.readLive().finally(next);
				} else {
					next();
				}
			}, fast ? 5_000 : 30_000);
		};
		// a run that starts while the read is slow: read fast from now on, not in up to 30 s
		this._register(onDispatchTurboChange(what => what === 'live' && !fast && going() && next()));
		this._register(toDisposable(() => mainWindow.clearTimeout(timer)));
		void this.readLive().finally(next);
		dispatchTurboHooks.open = part => {
			this.showTimeline();
			if (part !== undefined) {
				this.timeline.reveal(part);
			}
		};
		this._register(toDisposable(() => { dispatchTurboHooks.open = undefined; }));
		// the switch lives on a new chat's page only (no folder: a job across projects)
		this._register(autorun(reader => {
			const composer = composerService.activeComposer.read(reader);
			const onPage = !!composer && composerService.workspaceSelection.read(reader)?.state === 'noWorkspace';
			for (const ms of [0, 80, 450, 1300]) {
				const h = setTimeout(() => this.placeSwitch(onPage), ms);
				reader.store.add(toDisposable(() => clearTimeout(h)));
			}
		}));
		this._register(toDisposable(() => this.placeSwitch(false)));
	}

	/** The Timeline page, read afresh when it is on screen already. */
	showTimeline(): void {
		if (this.customViewService.activeCustomView.get()?.id === TIMELINE_VIEW_ID) {
			void this.timeline.refresh();
			return;
		}
		this.customViewService.showCustomView(TIMELINE_VIEW_ID);
	}

	private async readLive(): Promise<void> {
		try {
			const rows = await askTurbo<IRunRow[]>(this.commandService, 'list');
			if (!Array.isArray(rows)) {
				return;
			}
			const live = liveRun(rows);
			setDispatchTurboLive(live && (live.state !== 'done' || Date.now() / 1000 - (live.done_at ?? 0) < 3600) ? live : undefined);
		} catch {
			// what the window shows stays as it was
		}
	}

	// ---------------------------------------------------------------- the switch under the input box

	private placeSwitch(onPage: boolean): void {
		const host = onPage ? mainWindow.document.querySelector<HTMLElement>('.sessions-chat-widget .new-chat-secondary-controls-container') : null;
		if (!host) {
			if (!onPage) {
				this.chipHost?.remove();
				this.chipHost = undefined;
				this.note?.remove();
				this.note = undefined;
				this.chip?.dispose();
				this.chip = undefined;
				if (this.on) {
					this.setOn(false);
				}
			}
			return;
		}
		if (this.chipHost?.isConnected && this.chipHost.parentElement === host) {
			return;
		}
		this.chip?.dispose();
		this.chipHost?.remove();
		this.chipHost = dom.$('.dispatch-turbo-switch');
		this.chipHost.title = localize('dispatchTurbo.switchTip', "Turbo: your next message is split into parts that agents do at the same time, each in its own copy of the project, and combined at the end. You see the plan, the time and the allowance first.");
		host.prepend(this.chipHost);
		this.chip = new CheckboxChip({
			label: localize('dispatchTurbo.switch', "Turbo"),
			ariaLabel: localize('dispatchTurbo.switchAria', "Turbo: split the next message into parts that run at the same time"),
			onToggle: checked => this.setOn(checked),
			slotClassName: 'dispatch-turbo-chip',
		});
		this.chip.render(this.chipHost);
		this.chip.update({ checked: this.on, state: 'enabled' });
	}

	private setOn(on: boolean): void {
		this.on = on;
		this.chip?.update({ checked: on, state: 'enabled' });
		mainWindow.document.body.classList.toggle('dispatch-turbo-on', on);
		this.note?.remove();
		this.note = undefined;
		if (on && this.chipHost?.isConnected) {
			const first = !this.storageService.getBoolean(EXPLAINED_KEY, StorageScope.APPLICATION, false);
			this.storageService.store(EXPLAINED_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);
			const bottom = this.chipHost.closest('.new-chat-bottom-container');
			if (bottom?.parentElement) {
				this.note = dom.$(`.dispatch-turbo-note${first ? '.first' : ''}`);
				this.note.appendChild(renderIcon(Codicon.zap));
				dom.append(this.note, dom.$('span', undefined, first
					? localize('dispatchTurbo.explainFirst', "Turbo splits your next message into parts that agents do at the same time, each in its own copy of the project, and combines them into one result. You see the plan, the time and the allowance first; nothing runs before you press Start.")
					: localize('dispatchTurbo.explain', "Your next message becomes a Turbo plan. Nothing runs before you press Start.")));
				bottom.after(this.note);
			}
		}
	}

	private takeSend(query: string, pick?: ITurboPick): Promise<boolean> | undefined {
		if (!this.on || !this.chipHost?.isConnected || !query.trim()) {
			return undefined;
		}
		// the agent and model picked in the input box split the job and run the parts (task-o8wx)
		const engine = turboEngineOf(pick?.sessionType);
		const model = engine ? turboModelOf(engine, pick?.model) : undefined;
		return (async () => {
			// no folder: Turbo takes the project the message names, else the one worked in last (turbo.py pick_folder)
			const r = await askTurbo<ITurboRun>(this.commandService, 'plan', query.trim(), '', engine ? { engine, model } : undefined);
			if (r.ok === false || !r.id) {
				this.notificationService.warn(r.message || localize('dispatchTurbo.planFailed', "Turbo could not make a plan just now."));
				return false;
			}
			this.setOn(false);
			this.showTimeline();
			void this.timeline.refresh();
			return true;
		})();
	}
}
registerWorkbenchContribution2(DispatchTurboHome.ID, DispatchTurboHome, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		// not in the Command Palette: the page waits to be redone (2026-11-15, task-ccmyi)
		super({ id: DISPATCH_TIMELINE_OPEN, title: localize2('dispatchTurbo.openTimeline', "Show Timeline"), category: SessionsCategories.Sessions, f1: false, precondition: IsSessionsWindowContext });
	}
	override run(_accessor: ServicesAccessor): void {
		controller?.showTimeline();
	}
});
