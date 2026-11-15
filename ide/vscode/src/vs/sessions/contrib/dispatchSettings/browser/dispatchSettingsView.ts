/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Settings page in the middle of the Agents window (a custom view, like Waiting for you):
 *  the page the side bar's contents point at, or what a search found. Abilities and an agent's own page are the
 *  customizations editor shown in place (dispatchSettingsEmbedded.ts); the rest are Dispatch's own pages
 *  (dispatchSettingsPages.ts). Esc clears a search, then goes back to the sessions.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, derived, IObservable } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { EmbeddedCustomizations } from './dispatchSettingsEmbedded.js';
import { isEmbeddedPage, pageParent, pageTitle, SettingsPageId } from './dispatchSettingsModel.js';
import { DispatchSettingsPages } from './dispatchSettingsPages.js';
import { settingsData, SettingsDataKey } from './dispatchSettingsData.js';
import { DISPATCH_SETTINGS_CLOSE, escapeWasForAPopup, goToSettingsPage, setSettingsQuery, settingsLocation } from './dispatchSettingsState.js';
import { icon } from './dispatchSettingsDom.js';

const $ = DOM.$;

export class DispatchSettingsView extends AbstractCustomView {

	readonly title: IObservable<string> = derived(reader => {
		const loc = settingsLocation.read(reader);
		if (loc.query.trim()) {
			return localize('dispatchSettings.searchTitle', "Settings › Search");
		}
		// the way back as a breadcrumb: Settings › Agents › Claude Code
		const trail: string[] = [];
		for (let p: SettingsPageId | undefined = loc.page; p && p !== 'overview'; p = pageParent(p)) {
			trail.unshift(pageTitle(p));
		}
		return [pageTitle('overview'), ...trail].join(' › ');
	});

	override readonly description: IObservable<string | undefined> = derived(reader => {
		const loc = settingsLocation.read(reader);
		return loc.query.trim() ? undefined : DispatchSettingsPages.lede(loc.page);
	});

	override readonly maxWidth = 880;

	private root: HTMLElement | undefined;
	private body: HTMLElement | undefined;
	private embedded: EmbeddedCustomizations | undefined;
	private readonly pageStore = this._register(new MutableDisposable<DisposableStore>());
	private pages: DispatchSettingsPages | undefined;
	private size: { width: number; height: number } | undefined;
	private showingEmbedded = false;
	/** The embedded editor moved on its own: only the contents and the title follow. */
	private following = false;
	/** What the page on screen was drawn from (dispatchSettingsData.ts): drawn again when one of them changes. */
	private uses: ReadonlySet<SettingsDataKey> = new Set();
	private content: HTMLElement | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
	}

	render(container: HTMLElement): void {
		this.root = container;
		container.classList.add('dispatch-settings-page');
		container.tabIndex = -1;
		const close = () => void this.commandService.executeCommand(DISPATCH_SETTINGS_CLOSE);
		this.pages = this.instantiationService.createInstance(DispatchSettingsPages, {
			go: (page: SettingsPageId, flash?: string) => goToSettingsPage(page, flash),
			close,
			relayout: () => this.relayout(),
		});
		this.body = DOM.append(container, $('.dset-body'));
		this.embedded = this._register(this.instantiationService.createInstance(EmbeddedCustomizations, container, close));
		this._register(this.embedded.onDidMove(page => {
			this.following = true;
			try {
				goToSettingsPage(page);
			} finally {
				this.following = false;
			}
		}));
		this._register(DOM.addDisposableListener(container, DOM.EventType.KEY_DOWN, e => {
			if (e.key !== 'Escape' || e.defaultPrevented || escapeWasForAPopup()) {
				return;
			}
			// an open menu, a text being edited or a detail in the embedded editor takes Esc for itself
			const t = e.target as HTMLElement;
			if (t.closest('.monaco-editor, .monaco-inputbox, input, textarea, .context-view, .monaco-list')) {
				return;
			}
			DOM.EventHelper.stop(e, true);
			if (settingsLocation.get().query) {
				setSettingsQuery('');
			} else {
				close();
			}
		}));
		this._register(autorun(reader => {
			const loc = settingsLocation.read(reader);
			this.show(loc.page, loc.query, loc.flash);
		}));
		this._register(settingsData.onDidChange(changed => this.dataChanged(changed)));
		// the abilities' editor, made once what Settings reads as it opens is in (its lists draw that, not read again)
		const win = DOM.getWindow(container);
		void settingsData.refreshLocal().finally(() => {
			if (this.embedded && !this._store.isDisposed) {
				this._register(DOM.runWhenWindowIdle(win, () => this.embedded?.prepare(), 2_000));
			}
		});
		// the keyboard comes along: what was typed next must not go to the session's input behind the page
		DOM.getWindow(container).requestAnimationFrame(() => {
			const active = DOM.getActiveElement();
			if (!container.contains(active) && !active?.closest('.dispatch-settings-nav')) {
				this.focus();
			}
		});
	}

	private show(page: SettingsPageId, query: string, flash: string | undefined): void {
		const body = this.body!;
		const store = new DisposableStore();
		this.pageStore.value = store;
		DOM.clearNode(body);
		const embed = !query.trim() && isEmbeddedPage(page);
		this.showingEmbedded = embed;
		this.root?.classList.toggle('dset-embedded', embed);
		const parent = pageParent(page);
		if (!query.trim() && parent && parent !== 'overview') {
			const back = DOM.append(body, $('button.dset-back'));
			back.appendChild(icon(Codicon.chevronLeft));
			DOM.append(back, $('span', undefined, pageTitle(parent)));
			store.add(DOM.addDisposableListener(back, DOM.EventType.CLICK, () => goToSettingsPage(parent)));
		}
		if (embed) {
			if (!this.following) {
				void this.embedded?.show(page);
			}
		} else {
			this.embedded?.hide();
			const content = this.content = DOM.append(body, $('.dset-content'));
			content.classList.add('dset-anim');
			this.uses = settingsData.track(() => this.pages!.render(page, content, store, query));
		}
		this.relayout();
		if (flash) {
			// once the rows are there (some come a moment later)
			let tries = 0;
			const tryFlash = () => {
				const el = body.querySelector<HTMLElement>(`[data-setting="${CSS.escape(flash)}"]`);
				if (el) {
					el.scrollIntoView({ block: 'center' });
					el.classList.remove('dset-flash');
					void el.offsetWidth;
					el.classList.add('dset-flash');
				} else if (++tries < 20 && !store.isDisposed) {
					const h = setTimeout(tryFlash, 150);
					store.add({ dispose: () => clearTimeout(h) });
				}
			};
			tryFlash();
		}
	}

	/** What the page shows changed (a newer answer, a change made elsewhere): the page again, in place, where it was
	 *  scrolled to. Not while something on it is being typed into, and not Soul and Keys, which follow by themselves
	 *  (an open editor or form there keeps what is being typed). */
	private dataChanged(changed: ReadonlySet<SettingsDataKey>): void {
		const loc = settingsLocation.get();
		const content = this.content;
		if (this.showingEmbedded || loc.query.trim() || loc.page === 'soul' || loc.page === 'keys' || pageParent(loc.page) !== 'overview' || !content?.isConnected || ![...changed].some(k => this.uses.has(k))) {
			return;
		}
		const active = DOM.getActiveElement();
		if (active && content.contains(active) && active.matches('input, textarea, [contenteditable="true"]')) {
			return;
		}
		let scroller: HTMLElement | null = content.parentElement;
		while (scroller && scroller.scrollHeight <= scroller.clientHeight) {
			scroller = scroller.parentElement;
		}
		const top = scroller?.scrollTop ?? 0;
		const store = new DisposableStore();
		this.pageStore.value = store;
		const fresh = $('.dset-content');
		this.uses = settingsData.track(() => this.pages!.render(loc.page, fresh, store, loc.query));
		content.replaceWith(fresh);
		this.content = fresh;
		if (scroller) {
			scroller.scrollTop = top;
		}
		this.relayout();
	}

	private relayout(): void {
		if (!this.size || !this.body) {
			return;
		}
		if (this.showingEmbedded) {
			// Dispatch IDE (settings-embed-fit): the page's own top padding is room taken too; left out, the embedded
			// page came out that much taller than the room and the page scrolled around a card that scrolls itself
			// (What Dispatch changed on this Mac: a scroll bar in a box in a box)
			const pad = this.root ? parseFloat(DOM.getWindow(this.root).getComputedStyle(this.root).paddingTop) || 0 : 0;
			const backH = this.body.offsetHeight + pad;
			this.embedded?.layout(this.size.width, Math.max(200, this.size.height - backH - 8));
		}
	}

	layout(width: number, height: number): void {
		this.size = { width, height };
		this.relayout();
	}

	override focus(): void {
		if (this.showingEmbedded) {
			this.embedded?.focus();
		} else {
			this.root?.focus();
		}
	}
}
