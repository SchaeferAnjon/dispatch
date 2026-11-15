/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: What's new in the Agents window (kanban design/annotations/redesign 第 3 节,
 *  DECISIONS.md 「标注图四个触点」; patches/480-whats-new.patch). Data and timing: dispatchWhatsNewModel.ts.
 *
 *  - NEW next to a new feature's entry point, the same badge as the one VS Code puts next to
 *    Automations (outline, not coloured). Hovering it for 500 ms shows its snippet: the Where to look
 *    viewport on the feature (1:1), its name and one line, Got it and Show me. Using the entry point
 *    once, or Got it, takes the badge away for good.
 *  - What's new at the top left, where Update sits before the restart (outlined, not filled: nothing
 *    you must do), for 7 days after an update; while an update waits it is Update's place again.
 *    A click shows the card: VS Code's post-update widget made flat (no gradient banner), anchored
 *    under the entry, 420 wide, a row per feature (96×64 picture, name, one line, where), a click on
 *    a row is that feature's Show me; Release notes at the bottom. It never opens by itself.
 *  - Show me brings the entry point into view (the feature's command), flashes it once (2 s, the
 *    search-hit flash) and pops its snippet.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchWhatsNew.css';
import * as dom from '../../../../base/browser/dom.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { timeout } from '../../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Menus } from '../../../browser/menus.js';
import { DispatchThumbSize, DispatchWhereCard, setupDispatchPictureDetail, dispatchPictureUrl, renderDispatchWhereThumb } from '../../dispatchCommon/browser/dispatchWhere.js';
import { DispatchWhatsNewModel, findDispatchAnchor, IDispatchWhatsNewFeature } from './dispatchWhatsNewModel.js';
import { keepClearRects } from '../../dispatchTours/browser/dispatchToursBubble.js';

const $ = dom.$;

const SHOW_COMMAND = 'dispatch.whatsNew.show';
const SHOW_ME_COMMAND = 'dispatch.whatsNew.showMe';
const PREVIEW_COMMAND = 'dispatch.whatsNew.previewAsAfterUpdate';
const WhatsNewVisible = new RawContextKey<boolean>('dispatchWhatsNewVisible', false);

let model: DispatchWhatsNewModel | undefined;
let controller: DispatchWhatsNewController | undefined;

// ---------------------------------------------------------------- where it is
// Not in the title bar (kanban design/bars): the avatar menu always has What's New, and after an update the bottom
// bar shows a "What's new" block (contrib/dispatchStatusBar, class dispatch-whats-new-entry, the card's anchor)
// while `dispatchWhatsNewVisible` is set.

MenuRegistry.appendMenuItem(Menus.AccountMenu, { command: { id: SHOW_COMMAND, title: localize('dispatchWhatsNew.accountEntry', "What's New") }, group: '3_help', order: 0 });

// ---------------------------------------------------------------- the controller: badges, card, Show me

class DispatchWhatsNewController extends Disposable {

	private readonly badges = this._register(new DisposableMap<HTMLElement>());
	private scanScheduled = false;
	private readonly cardStore = this._register(new DisposableStore());
	private cardOpen = false;
	private showingMe = false;

	constructor(
		private readonly model: DispatchWhatsNewModel,
		@IHoverService private readonly hoverService: IHoverService,
		@ICommandService private readonly commandService: ICommandService,
		@IFileService private readonly fileService: IFileService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();
		// entry points come and go (menus, tabs, the Customizations list redraws): watch the DOM only
		// while some feature still has a badge to show
		const observer = new MutationObserver(() => this.scheduleScan());
		let watching = false;
		const watch = () => {
			const want = model.badged.length > 0;
			if (want && !watching) {
				observer.observe(mainWindow.document.body, { childList: true, subtree: true });
			} else if (!want && watching) {
				observer.disconnect();
			}
			watching = want;
		};
		this._register(toDisposable(() => observer.disconnect()));
		this._register(model.onDidChange(() => {
			watch();
			this.scheduleScan();
		}));
		watch();
		// using an entry point once takes its badge away
		this._register(dom.addDisposableListener(mainWindow.document, dom.EventType.CLICK, e => this.onClick(e), true));
		this.scheduleScan();
	}

	// ---- badges

	private scheduleScan(): void {
		if (this.scanScheduled) {
			return;
		}
		this.scanScheduled = true;
		mainWindow.requestAnimationFrame(() => {
			this.scanScheduled = false;
			this.scan();
		});
	}

	private scan(): void {
		const want = new Map<HTMLElement, IDispatchWhatsNewFeature>();
		for (const f of this.model.badged) {
			for (const el of findDispatchAnchor(mainWindow.document, f.anchor!)) {
				want.set(el, f);
			}
		}
		for (const [el] of this.badges) {
			// gone, no longer wanted, or its badge wiped by the entry's own re-render: drop (and redo below)
			if (!want.has(el) || !el.isConnected || !el.querySelector('.dispatch-new-badge')) {
				this.badges.deleteAndDispose(el);
			}
		}
		for (const [el, f] of want) {
			if (!this.badges.has(el)) {
				this.badges.set(el, this.attachBadge(el, f));
			}
		}
	}

	private attachBadge(anchor: HTMLElement, f: IDispatchWhatsNewFeature): DisposableStore {
		const store = new DisposableStore();
		const badge = $('span.dispatch-new-badge', { 'data-feature': f.id }, localize('dispatchWhatsNew.new', "New"));
		badge.setAttribute('aria-label', localize('dispatchWhatsNew.badgeAria', "New: {0}", f.title));
		badge.tabIndex = -1;
		// in an editor tab it goes right after the label, before the tab's own buttons
		const label = anchor.querySelector(':scope > .tab-label');
		if (label) {
			label.after(badge);
		} else {
			anchor.appendChild(badge);
		}
		anchor.classList.add('dispatch-has-new-badge');
		store.add(toDisposable(() => {
			badge.remove();
			anchor.classList.remove('dispatch-has-new-badge');
		}));
		const cardStore = store.add(new DisposableStore());
		const options = () => {
			cardStore.clear();
			return {
				content: this.snippet(f, cardStore),
				additionalClasses: ['dispatch-where-hover'],
				appearance: { showPointer: true },
				position: { hoverPosition: HoverPosition.RIGHT },
				persistence: { hideOnHover: false },
			};
		};
		if (!anchor.closest('.tab')) {
			store.add(this.hoverService.setupDelayedHover(badge, options, { groupId: 'dispatch-whats-new' }));
			return store;
		}
		// in a tab the tab's own title hover ("Tasks") comes up first and keeps the delayed one away:
		// pointing at NEW for 600 ms puts the snippet in its place
		let timer: number | undefined;
		const cancel = () => {
			if (timer !== undefined) {
				mainWindow.clearTimeout(timer);
				timer = undefined;
			}
		};
		store.add(dom.addDisposableListener(badge, dom.EventType.MOUSE_ENTER, () => {
			cancel();
			timer = mainWindow.setTimeout(() => {
				timer = undefined;
				this.hoverService.hideHover(true);
				this.hoverService.showInstantHover({ ...options(), target: badge });
			}, 600);
		}));
		store.add(dom.addDisposableListener(badge, dom.EventType.MOUSE_LEAVE, cancel));
		store.add(toDisposable(cancel));
		return store;
	}

	/** The badge's snippet: the viewport on the feature, its name and one line, Got it / Show me. */
	private snippet(f: IDispatchWhatsNewFeature, store: DisposableStore): HTMLElement {
		const holder = $('.dispatch-whats-new-snippet');
		const subtitle = [f.description, f.where ? `${f.where}.` : ''].filter(Boolean).join(' ');
		const actions = [
			{ label: localize('dispatchWhatsNew.gotIt', "Got it"), start: true, run: () => { this.hoverService.hideHover(true); this.model.markSeen(f.id); } },
			{ label: localize('dispatchWhatsNew.showMe', "Show me"), icon: 'arrow-right', run: () => { this.hoverService.hideHover(true); void this.showMe(f); } },
		];
		if (f.picture) {
			const picture = f.picture;
			const card = store.add(new DispatchWhereCard(picture, undefined, { title: f.title, subtitle, order: 'picture', mark: f.mark, bare: true, actions }));
			holder.appendChild(card.element);
			void dispatchPictureUrl(this.fileService, URI.parse(picture.image)).then(url => {
				if (url && !store.isDisposed) {
					const img = card.viewer.viewport.querySelector('img');
					if (img) {
						img.src = url;
					}
				}
			});
		} else {
			const card = store.add(new DispatchWhereCard({ image: '', marks: [] }, undefined, { title: f.title, subtitle, bare: true, actions, height: 0 }));
			card.viewer.element.remove();
			holder.appendChild(card.element);
		}
		return holder;
	}

	private onClick(e: MouseEvent): void {
		if (this.showingMe) {
			return;
		}
		const t = e.target as HTMLElement | null;
		if (!t) {
			return;
		}
		for (const [el] of this.badges) {
			if (el.contains(t)) {
				const id = el.querySelector<HTMLElement>('.dispatch-new-badge')?.dataset.feature;
				if (id) {
					// let the click do its thing first, then drop the badge
					setTimeout(() => this.model.markSeen(id), 0);
				}
			}
		}
	}

	// ---- Show me

	async showMe(f: IDispatchWhatsNewFeature): Promise<void> {
		this.showingMe = true;
		try {
			this.hideCard();
			if (f.command) {
				try {
					await this.commandService.executeCommand(f.command, ...(f.args ?? []));
				} catch {
					// the spot may be on screen anyway: look for it
				}
			}
			// the page may still be opening: look for the spot for up to 2 s
			let target: HTMLElement | undefined;
			for (let i = 0; i < 20 && !target; i++) {
				target = findDispatchAnchor(mainWindow.document, f.target ?? f.anchor ?? { selector: ':not(*)' })[0];
				if (!target) {
					await timeout(100);
				}
			}
			if (!target) {
				return;
			}
			target.scrollIntoView({ block: 'center', behavior: 'smooth' });
			await timeout(250);
			target.classList.remove('dispatch-whats-new-flash');
			void target.offsetWidth;
			target.classList.add('dispatch-whats-new-flash');
			setTimeout(() => target!.classList.remove('dispatch-whats-new-flash'), 2100);
			// NEW pops its snippet
			const anchorEl = f.anchor ? findDispatchAnchor(mainWindow.document, f.anchor)[0] : undefined;
			const badge = anchorEl?.querySelector<HTMLElement>('.dispatch-new-badge');
			if (badge) {
				const store = new DisposableStore();
				this.hoverService.showInstantHover({
					content: this.snippet(f, store),
					target: { targetElements: [badge], dispose: () => store.dispose() },
					additionalClasses: ['dispatch-where-hover'],
					appearance: { showPointer: true },
					position: { hoverPosition: HoverPosition.RIGHT },
					persistence: { hideOnHover: false, sticky: false },
				});
			}
		} finally {
			setTimeout(() => this.showingMe = false, 300);
		}
	}

	// ---- the card

	/** welcome: the one time a new user's first run opens it (Welcome to Dispatch). */
	toggleCard(anchor: HTMLElement | undefined, welcome = false): void {
		if (this.cardOpen) {
			this.hideCard();
			return;
		}
		if (!anchor) {
			return;
		}
		this.cardStore.clear();
		const content = this.card(welcome);
		this.cardOpen = true;
		// Consume Escape before the workbench can also close the setup page underneath.
		this.cardStore.add(dom.addDisposableListener(mainWindow.document, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Escape' && this.cardOpen) {
				e.preventDefault(); e.stopImmediatePropagation(); this.hideCard();
				(mainWindow.document.querySelector<HTMLElement>('.dispatch-onboarding .dob-btn.fill') ?? anchor).focus();
			}
		}, true));
		// the bottom bar's entry shows it is open (a title bar button the welcome hangs from keeps its look)
		const marksOpen = anchor.classList.contains('dispatch-whats-new-entry');
		anchor.classList.toggle('open', marksOpen);
		// The welcome opens by itself, from the title bar's right end down, and stops above the message box (its
		// Turbo and send buttons) and the bottom bar: right after the setup the person's next step is to type there
		// (kanban task-5dom6; it used to rise from the bottom bar and cover the box's right half). It scrolls when
		// the window is short, and a window with no room for it above the box does not get it at all: it would sit on
		// the box (task-lj06.21; What's New in the account menu still has it). An update's card opens on a click from
		// the bottom bar, as before.
		const welcomeHeight = welcome ? welcomeMaxHeightRatio(anchor) : undefined;
		if (welcome && welcomeHeight === undefined) {
			this.cardOpen = false;
			anchor.classList.remove('open');
			return;
		}
		// the hover calls the target's dispose when it goes (Escape, a click elsewhere, a row)
		const widget = this.hoverService.showInstantHover({
			content,
			target: { targetElements: [anchor], dispose: () => { this.cardOpen = false; if (marksOpen) { anchor.classList.remove('open'); } } },
			// the welcome is marked: it opened by itself, so the end-to-end check holds it to the tips' rule (never on the box)
			additionalClasses: welcome ? ['dispatch-whats-new-hover', 'dispatch-whats-new-auto'] : ['dispatch-whats-new-hover'],
			appearance: { showPointer: false, compact: true, maxHeightRatio: welcomeHeight ?? 1 },
			position: { hoverPosition: HoverPosition.BELOW, forcePosition: welcomeHeight !== undefined },
			persistence: { sticky: true },
			trapFocus: true,
		}, true);
		if (!widget) {
			this.cardOpen = false;
			if (marksOpen) {
				anchor.classList.remove('open');
			}
		}
	}

	private hideCard(): void {
		if (this.cardOpen) {
			this.hoverService.hideHover(true);
			this.cardOpen = false;
		}
		this.cardStore.clear();
	}

	/** VS Code's post-update card, flat: title and date, a row per feature, Release notes. */
	private card(welcome = false): HTMLElement {
		const features = this.model.features;
		const root = $('.dispatch-whats-new-card', { role: 'dialog' });
		root.setAttribute('aria-label', localize('dispatchWhatsNew.cardAria', "What's new in this update"));
		const head = dom.append(root, $('.wt'));
		dom.append(head, $('b', undefined, welcome ? localize('dispatchWhatsNew.welcomeTitle', "Welcome to Dispatch") : localize('dispatchWhatsNew.cardTitle', "New in this update")));
		const since = this.model.data?.date ? new Date(`${this.model.data.date}T12:00:00`) : new Date(this.model.since ?? Date.now());
		const when = since.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
		// a new person's welcome counts what there is to try; an update says when. No video placeholder: a "coming
		// soon" box read as unfinished (task-lj06.26); a video goes in when there is one.
		dom.append(head, $('span', undefined, welcome
			? (features.length === 1 ? localize('dispatchWhatsNew.oneToTry', "1 thing to try") : localize('dispatchWhatsNew.toTry', "{0} things to try", features.length))
			: features.length === 1 ? localize('dispatchWhatsNew.oneThing', "{0} · 1 thing", when) : localize('dispatchWhatsNew.things', "{0} · {1} things", when, features.length)));
		const rows = dom.append(root, $('.wnrows', { role: 'list' }));
		for (const f of features) {
			const row = dom.append(rows, $('button.wnrow', { type: 'button', role: 'listitem' }));
			row.setAttribute('aria-label', `${f.title}. ${f.description} ${f.where}`);
			const thumb = renderDispatchWhereThumb(undefined, f.picture, { size: DispatchThumbSize.row, fit: 'marks', only: f.mark ? [f.mark] : undefined });
			row.appendChild(thumb);
			if (f.picture) {
				const picture = f.picture;
				setupDispatchPictureDetail(root, row, picture, f.mark ?? picture.marks[0]?.n, f.title, image => dispatchPictureUrl(this.fileService, image), this.cardStore, { label: 'Show me', run: () => { void this.showMe(f); } });
				void dispatchPictureUrl(this.fileService, URI.parse(picture.image)).then(url => {
					if (url && !this.cardStore.isDisposed) {
						const fresh = renderDispatchWhereThumb(url, picture, { size: DispatchThumbSize.row, fit: 'marks', only: f.mark ? [f.mark] : undefined });
						thumb.replaceWith(fresh);
					}
				});
			}
			const text = dom.append(row, $('.wntext'));
			dom.append(text, $('.a', undefined, f.title));
			if (f.description) {
				dom.append(text, $('.b', undefined, f.description));
			}
			if (f.where) {
				const c = dom.append(text, $('.c'));
				dom.append(c, $(`span.codicon.codicon-${f.icon ?? 'location'}`));
				dom.append(c, $('span', undefined, f.where));
			}
			this.cardStore.add(dom.addDisposableListener(row, dom.EventType.CLICK, e => {
				e.preventDefault();
				void this.showMe(f);
			}));
		}
		const foot = dom.append(root, $('.wnf'));
		const notes = this.model.data?.releaseNotes;
		if (notes) {
			const b = dom.append(foot, $('button.dispatch-where-ghost', { type: 'button' }));
			dom.append(b, $('span', undefined, localize('dispatchWhatsNew.releaseNotes', "Release notes")));
			dom.append(b, $('span.codicon.codicon-arrow-right'));
			this.cardStore.add(dom.addDisposableListener(b, dom.EventType.CLICK, () => {
				this.hideCard();
				void this.openerService.open(URI.parse(notes), { openExternal: true });
			}));
		}
		const dismiss = dom.append(foot, $('button.dispatch-where-ghost', { type: 'button' }, localize('dispatchWhatsNew.dismiss', "Got it")));
		this.cardStore.add(dom.addDisposableListener(dismiss, dom.EventType.CLICK, () => this.hideCard()));
		return root;
	}
}

/** The welcome card's column at the window's right end: its width and the margin round it. */
const WELCOME_COLUMN = 460;

/** Where the welcome card hangs from: the right end of the title bar (the accounts button). */
function welcomeAnchor(): HTMLElement | undefined {
	const items = [...mainWindow.document.querySelectorAll<HTMLElement>('.part.titlebar .titlebar-right .action-item')].filter(e => e.offsetParent);
	return items.at(-1);
}

/**
 * The welcome card's height as a share of the window: from under the title bar to above what it must not cover in
 * its column, the message box with its buttons (the tips' keep-clear list, measured, not a fixed 196 px that missed
 * a taller box) and the bottom bar. Undefined when that leaves less than a useful card.
 */
function welcomeMaxHeightRatio(anchor: HTMLElement): number | undefined {
	const win = dom.getWindow(anchor);
	const top = anchor.getBoundingClientRect().bottom + 8;
	const column = { left: win.innerWidth - WELCOME_COLUMN, right: win.innerWidth };
	const bar = win.document.querySelector<HTMLElement>('.part.statusbar')?.getBoundingClientRect();
	const below = [...keepClearRects(win.document), ...(bar && bar.height ? [{ left: bar.left, top: bar.top, width: bar.width, height: bar.height }] : [])]
		.filter(r => r.top + r.height > top && r.left < column.right && column.left < r.left + r.width);
	const bottom = Math.min(win.innerHeight - 8, ...below.map(r => r.top - 8));
	const room = bottom - top;
	return room >= 240 && anchor.closest('.part.titlebar') ? room / win.innerHeight : undefined;
}

// ---------------------------------------------------------------- wiring

class DispatchWhatsNewContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dispatchWhatsNew';

	private readonly visible: IContextKey<boolean>;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		const m = this._register(instantiationService.createInstance(DispatchWhatsNewModel));
		model = m;
		controller = this._register(instantiationService.createInstance(DispatchWhatsNewController, m));
		this._register(toDisposable(() => { model = undefined; controller = undefined; }));
		this.visible = WhatsNewVisible.bindTo(contextKeyService);
		const update = () => this.visible.set(m.showEntry);
		this._register(m.onDidChange(update));
		update();
	}
}

registerWorkbenchContribution2(DispatchWhatsNewContribution.ID, DispatchWhatsNewContribution, WorkbenchPhase.BlockRestore);

registerAction2(class extends Action2 {
	constructor() {
		super({ id: SHOW_COMMAND, title: localize2('dispatchWhatsNew.showTitle', "What's New in This Update"), f1: false });
	}
	run(): void {
		const entry = mainWindow.document.querySelector<HTMLElement>('.dispatch-whats-new-entry');
		controller?.toggleCard(entry ?? undefined);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: SHOW_ME_COMMAND, title: localize2('dispatchWhatsNew.showMeTitle', "Show Me a New Feature"), f1: false });
	}
	async run(_accessor: ServicesAccessor, id?: string): Promise<void> {
		const f = model?.features.find(x => x.id === id) ?? model?.data?.features.find(x => x.id === id);
		if (f) {
			await controller?.showMe(f);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PREVIEW_COMMAND,
			title: localize2('dispatchWhatsNew.previewTitle', "Show What's New as After an Update"),
			category: localize2('developer', "Developer"),
			f1: true,
		});
	}
	async run(): Promise<void> {
		await model?.ready;
		await model?.previewAsAfterUpdate();
	}
});

registerAction2(class extends Action2 {
	constructor() { super({ id: 'dispatch.whatsNew.welcome', title: localize2('dispatchWhatsNew.welcome', "Welcome to Dispatch"), f1: false }); }
	async run(): Promise<void> {
		if (!await model?.welcomeOnce()) { return; }
		await timeout(150);
		const anchor = welcomeAnchor() ?? mainWindow.document.querySelector<HTMLElement>('.dispatch-whats-new-entry') ?? mainWindow.document.querySelector<HTMLElement>('.dispatch-onboarding .dob-title');
		controller?.toggleCard(anchor ?? undefined, true);
	}
});
