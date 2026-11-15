/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: while Settings is open, the side bar shows its contents instead of the sessions (direction B):
 *  "‹ Sessions" with the number of things waiting for you, a search box, Overview, the eight pages, and under
 *  Advanced the abilities (what was Customizations), always open. The sessions slide out to the left, the
 *  contents slide in from the right; going back reverses it. The side bar part itself is untouched: the
 *  contents are a layer over its content area.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { dispatchWaitingVisible } from '../../sessions/browser/dispatchWaitingModel.js';
import { icon } from './dispatchSettingsDom.js';
import { ABILITIES, ISettingsNavItem, navOwner, pagesOf, searchSettings, SETTINGS_NAV, SettingsPageId } from './dispatchSettingsModel.js';
import { DISPATCH_SETTINGS_CLOSE, escapeWasForAPopup, goToSettingsPage, setSettingsQuery, settingsLocation } from './dispatchSettingsState.js';
import './dispatchSettingsEditorLink.js';

const $ = DOM.$;

export class DispatchSettingsNav extends Disposable {

	private readonly element: HTMLElement;
	private input!: HTMLInputElement;
	private list!: HTMLElement;
	private count!: HTMLElement;
	private readonly rows = new Map<SettingsPageId, HTMLElement>();
	private readonly mounted = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.element = $('.dispatch-settings-nav', { role: 'navigation', 'aria-label': localize('dispatchSettings.navLabel', "Settings") });
		this.build();
		this._register(autorun(reader => {
			const loc = settingsLocation.read(reader);
			this.update(loc.page, loc.query);
		}));
		this._register(autorun(reader => {
			const n = dispatchWaitingVisible.read(reader)?.counts?.attention ?? 0;
			this.count.textContent = n ? String(n) : '';
			this.count.hidden = !n;
			this.count.title = n ? localize('dispatchSettings.waitingTitle', "{0} things wait for you", n) : '';
		}));
	}

	private part(): HTMLElement | undefined {
		return this.layoutService.getContainer(mainWindow, Parts.SIDEBAR_PART) ?? undefined;
	}

	/** The side bar was hidden and Settings showed it: hidden again when Settings closes. */
	private unhid = false;
	/** Shown, and not hidden since: the class goes on a frame later, and only then if it still is. */
	private wanted = false;

	/** Puts the contents over the side bar and slides them in. */
	show(focusSearch: boolean): void {
		if (!this.layoutService.isVisible(Parts.SIDEBAR_PART, mainWindow)) {
			this.layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
			this.unhid = true;
		}
		const part = this.part();
		if (!part) {
			return;
		}
		if (this.element.parentElement !== part) {
			if (DOM.getWindow(part).getComputedStyle(part).position === 'static') {
				part.style.position = 'relative';
			}
			part.appendChild(this.element);
			const store = new DisposableStore();
			this.mounted.value = store;
			// below the side bar's own title row (the window buttons sit there)
			const place = () => {
				const title = part.querySelector<HTMLElement>(':scope > .title');
				this.element.style.top = `${title?.offsetHeight ?? 0}px`;
			};
			place();
			const ro = new ResizeObserver(place);
			ro.observe(part);
			store.add({ dispose: () => ro.disconnect() });
		}
		// the next frame, so the slide runs from where the sessions are. In a window behind others that frame can come
		// after Back was pressed (10-08, slash-menu): then it stays closed
		this.wanted = true;
		DOM.getWindow(part).requestAnimationFrame(() => {
			if (this.wanted) {
				part.classList.add('dispatch-settings-open');
			}
		});
		if (focusSearch) {
			this.input.focus();
		}
	}

	hide(): void {
		this.wanted = false;
		this.part()?.classList.remove('dispatch-settings-open');
		if (this.input) {
			this.input.blur();
		}
		if (this.unhid) {
			this.unhid = false;
			this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
		}
	}

	override dispose(): void {
		this.hide();
		this.element.remove();
		super.dispose();
	}

	private build(): void {
		const el = this.element;
		const back = DOM.append(el, $('button.dsn-back'));
		back.appendChild(icon(Codicon.chevronLeft));
		DOM.append(back, $('span.dsn-back-t', undefined, localize('dispatchSettings.sessions', "Sessions")));
		this.count = DOM.append(back, $('span.dsn-count'));
		back.title = localize('dispatchSettings.backTitle', "Back to your sessions (Esc)");
		this._register(DOM.addDisposableListener(back, DOM.EventType.CLICK, () => void this.commandService.executeCommand(DISPATCH_SETTINGS_CLOSE)));

		const search = DOM.append(el, $('.dsn-search'));
		search.appendChild(icon(Codicon.search));
		this.input = DOM.append(search, $('input', {
			type: 'text',
			placeholder: localize('dispatchSettings.searchPlaceholder', "Search settings"),
			'aria-label': localize('dispatchSettings.searchLabel', "Search settings"),
			spellcheck: 'false',
		})) as HTMLInputElement;
		const clear = DOM.append(search, $('button.dsn-clear', { title: localize('dispatchSettings.clear', "Clear"), 'aria-label': localize('dispatchSettings.clear2', "Clear search") }));
		clear.appendChild(icon(Codicon.close));
		this._register(DOM.addDisposableListener(clear, DOM.EventType.CLICK, () => { this.input.value = ''; setSettingsQuery(''); this.input.focus(); }));
		this._register(DOM.addDisposableListener(this.input, DOM.EventType.INPUT, () => setSettingsQuery(this.input.value)));
		this._register(DOM.addDisposableListener(this.input, DOM.EventType.KEY_DOWN, e => {
			if (e.key === 'Escape') {
				DOM.EventHelper.stop(e, true);
				if (escapeWasForAPopup()) {
					return;
				}
				if (this.input.value) {
					this.input.value = '';
					setSettingsQuery('');
				} else {
					void this.commandService.executeCommand(DISPATCH_SETTINGS_CLOSE);
				}
			} else if (e.key === 'Enter') {
				const first = searchSettings(this.input.value)[0];
				if (first) {
					DOM.EventHelper.stop(e, true);
					this.input.value = '';
					goToSettingsPage(first.entry.page, first.entry.key);
				}
			} else if (e.key === 'ArrowDown') {
				DOM.EventHelper.stop(e, true);
				this.list.querySelector<HTMLElement>('.dsn-row:not(.dim)')?.focus();
			}
		}));

		this.list = DOM.append(el, $('.dsn-list'));
		this.navRow({ id: 'overview', label: localize('dispatchSettings.overview', "Overview"), icon: 'settings-gear' });
		DOM.append(this.list, $('.dsn-gap'));
		for (const item of SETTINGS_NAV) {
			this.navRow(item);
		}
		DOM.append(this.list, $('.dsn-head', undefined, localize('dispatchSettings.advancedHead', "Advanced")));
		const abilities = this.navRow({ id: 'abilities', label: localize('dispatchSettings.abilitiesRow', "Abilities"), icon: 'tools' });
		abilities.appendChild(icon(Codicon.chevronDown, 'dsn-caret'));
		const kids = DOM.append(this.list, $('.dsn-kids'));
		for (const item of ABILITIES) {
			this.navRow(item, kids).classList.add('kid');
		}
		const foot = DOM.append(el, $('.dsn-foot'));
		// Tab completion and ⌘K are the editor window's: this row opens them in its Settings (dispatchSettingsEditorLink.ts)
		const editorRow = this.navRow({ id: 'editor', label: localize('dispatchSettings.editorWindowSettings', "Editor window settings"), icon: 'code' }, foot);
		editorRow.title = localize('dispatchSettings.editorWindowTitle2', "Tab completion and ⌘K are in the editor window's settings");
		editorRow.appendChild(icon(Codicon.linkExternal, 'dsn-out'));

		this._register(DOM.addDisposableListener(this.list, DOM.EventType.KEY_DOWN, e => {
			if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
				return;
			}
			const all = [...el.querySelectorAll<HTMLElement>('.dsn-row:not(.dim)')];
			const i = all.indexOf(e.target as HTMLElement);
			if (i < 0) {
				return;
			}
			DOM.EventHelper.stop(e, true);
			if (e.key === 'ArrowUp' && i === 0) {
				this.input.focus();
				return;
			}
			all[Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
		}));
	}

	private navRow(item: ISettingsNavItem, parent: HTMLElement = this.list): HTMLElement {
		const r = DOM.append(parent, $('button.dsn-row'));
		r.dataset.page = item.id;
		r.appendChild(icon(item.icon));
		DOM.append(r, $('span.dsn-t', undefined, item.label));
		this.rows.set(item.id, r);
		this._register(DOM.addDisposableListener(r, DOM.EventType.CLICK, () => {
			this.input.value = '';
			goToSettingsPage(item.id);
		}));
		return r;
	}

	private update(page: SettingsPageId, query: string): void {
		const hits = query.trim() ? pagesOf(searchSettings(query)) : undefined;
		const owner = navOwner(page);
		for (const [id, r] of this.rows) {
			const on = !hits && id === owner;
			r.classList.toggle('on', on);
			r.toggleAttribute('aria-current', on);
			r.classList.toggle('dim', !!hits && !hits.has(id));
			r.classList.toggle('hit', !!hits && hits.has(id));
		}
		if (this.input && this.input.value !== query) {
			this.input.value = query;
		}
	}
}
